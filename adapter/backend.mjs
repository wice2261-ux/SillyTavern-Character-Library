// Transforms the pinned 1.18.0 source after the installer's fingerprint check.
function replace(source, before, after) {
    if (source.split(before).length !== 2) throw Error('Missing or ambiguous anchor: ' + before);
    return source.replace(before, () => after);
}

export function backend(source) {
    for (const call of [
        'await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request);',
        'await writeCharacterData(uploadPath, char, internalName, request, crop);',
    ]) source = replace(source, call, 'if (!' + call.slice(0, -1) + ') return response.sendStatus(500);\n            request.libraryCreatedAvatars = [avatarName];');
    source = replace(source, '        response.send({ file_name: fileName });',
        "        if (request.libraryReplacement !== true) request.libraryCreatedAvatars = [fileName + '.png'];\n        response.send({ file_name: fileName });");
    source = replace(source, '        response.send({ path: path.parse(newFilename).base });',
        '        request.libraryCreatedAvatars = [path.parse(newFilename).base];\n        response.send({ path: path.parse(newFilename).base });');
    const router = 'export const router = express.Router();';
    const helpers = `
const library = () => globalThis[Symbol.for('st.character-library')];
function checkNewAvatar(dirs, avatar) {
    const hook = library();
    hook?.assertWritableName(dirs, avatar);
    if (hook && fs.existsSync(path.join(dirs.characters, avatar))) {
        throw Object.assign(new Error('已有同名角色，请另存为新文件名。'), { status: 409 });
    }
}
function sendLibraryConflict(response, error) {
    return response.status(409).send({ code: 'CHARACTER_LIBRARY_CONFLICT', error: error.message, message: error.message });
}
const isReserved = (dirs, avatar) => library()?.reserved(dirs, avatar) ??
    (path.basename(avatar) === avatar && fs.existsSync(path.join(dirs.root, 'character-library', 'cards', avatar)));

function hasUnmanagedColdFiles(dirs) {
    const folder = path.join(dirs.root, 'character-library', 'cards');
    if (!fs.existsSync(folder)) return false;
    const dir = fs.opendirSync(folder);
    try {
        for (let entry; (entry = dir.readSync());) if (entry.name.endsWith('.png')) return true;
        return false;
    } finally { dir.closeSync(); }
}

globalThis[Symbol.for('st.character-library.invalidate')] = async (dirs, avatar) => {
    if (path.basename(avatar) !== avatar) throw Error('Invalid avatar');
    const filename = path.join(dirs.characters, avatar);
    for (const key of [...memoryCache.keys()]) {
        if (key === filename || key.startsWith(filename + '-')) memoryCache.delete(key);
    }
    if (useDiskCache && fs.existsSync(filename)) {
        const key = getCacheKey(filename);
        await (await diskCache.instance()).removeItem(key);
    }
    invalidateThumbnail(dirs, 'avatar', avatar);
};

function libraryRoute(handler) {
    return async (request, response, next) => {
        const uploadPath = request.file && path.join(request.file.destination, request.file.filename);
        try {
            const hook = library();
            const work = () => handler(request, response);
            return await (hook ? hook.runNative(request, work) : work());
        } catch (error) {
            if (error.status === 409) return sendLibraryConflict(response, error);
            return next(error);
        } finally {
            if (uploadPath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
        }
    };
}
`;
    source = replace(source, router, router + '\n' + helpers);
    let count = 0;
    source = source.replace(/^(router\.post\('[^']+', [^\n]*?)(async function \(request, response\) \{[\s\S]*?^\})\);/gm,
        (_, head, handler) => { count++; return head + 'libraryRoute(' + handler + '));'; });
    if (count !== 13) throw Error('Unexpected native character route count: ' + count);
    const from = source.indexOf('        const processingPromises = pngFiles.map');
    const diagnostic = source.indexOf('        // Local diagnostic patch: serial character-list parsing');
    const start = from < 0 ? diagnostic : from;
    const end = source.indexOf('        return response.send(data);', start);
    if (start < 0 || end < start) throw Error('Missing native character list route');
    source = source.slice(0, start) + `        const managed = library()?.managed(request.user.directories) ?? hasUnmanagedColdFiles(request.user.directories);
        response.setHeader('X-ST-Character-Library', managed ? 'managed' : (library() ? 'available' : 'inactive'));
        const data = [];
        for (const file of pngFiles) {
            const character = await processCharacter(file, request.user.directories, { shallow: Boolean(library()) || managed || useShallowCharacters });
            if (character.name) data.push(character);
        }
` + source.slice(end);
    const batch = '            // Process in parallel with a concurrency limit';
    const last = '            return response.send({ updated, skipped, failed });';
    source = replace(source, source.slice(source.indexOf(batch), source.indexOf(last)),
        '            for (const avatar of targetAvatars) await processOne(avatar);\n            request.libraryUpdatedAvatars = updated;\n\n');
    source = replace(source, 'return getUniqueName(file, (name) => fs.existsSync(path.join(directories.characters, `${name}.png`)),',
        'const result = getUniqueName(file, (name) => fs.existsSync(path.join(directories.characters, name + \'.png\')) || isReserved(directories, name + \'.png\'),');
    source = replace(source, 'maxTries: 10000 }) ?? file;',
        "maxTries: 10000 });\n    if (!result) throw Error('No available character filename');\n    library()?.assertWritableName(directories, result + '.png');\n    return result;");
    // The hook may establish managed identities; unmanaged reads only query existing ones.
    const readCard = '        const imgFile = path.join(directories.characters, item);';
    source = replace(source, readCard, '        const id = library()?.cardId(directories, item, !shallow);\n' + readCard);
    const processed = '        return shallow ? toShallow(character) : character;';
    source = replace(source, processed, `        const result = shallow ? toShallow(character) : character;
        if (id) result.libraryId = id;
        else delete result.libraryId;
        return result;`);
    source = replace(source, "creator_notes: _.get(character, 'data.creator_notes', ''),",
        "creator_notes: String(_.get(character, 'data.creator_notes', '') ?? '').slice(0, 512),");
    source = replace(source, "    _.unset(update, 'json_data');", "    _.unset(update, 'json_data');\n    _.unset(update, 'libraryId');");
    source = replace(source, '    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);\n    return { ok: true };',
        "    const written = await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);\n    return written ? { ok: true } : { ok: false, error: 'Failed to write character file' };");
    source = replace(source, '        const chatsPath = path.join(request.user.directories.chats, internalName);',
        '        checkNewAvatar(request.user.directories, avatarName);\n        if (isReserved(request.user.directories, avatarName)) return sendLibraryConflict(response, Error(\'文件名已被占用，请另存。\'));\n        const chatsPath = path.join(request.user.directories.chats, internalName);');
    source = replace(source, '    const preservedFileName = getPreservedName(request);',
        "    const preservedFileName = getPreservedName(request);\n    if (request.libraryReplacement === true) {\n        const raw = await readCharacterData(path.join(request.user.directories.characters, request.body.library_replace_avatar));\n        if (!raw) throw Error('无法读取原卡，替换已停止。');\n        const original = JSON.parse(raw);\n        request.libraryReplacementCreateDate = original.create_date;\n        request.libraryReplacementChat = typeof original.chat === 'string' && original.chat.trim()\n            ? original.chat : (original.data?.name ?? original.name) + ' - ' + humanizedDateTime();\n    }\n    if (preservedFileName && request.libraryReplacement !== true) {\n        checkNewAvatar(request.user.directories, preservedFileName + '.png');\n        if (isReserved(request.user.directories, preservedFileName + '.png')) return sendLibraryConflict(response, Error('文件名已被占用，请另存。'));\n    }");
    source = replace(source, '        const outputImage = write(inputImage, data);', `        if (request.libraryReplacement === true && outputFile + '.png' === request.body.library_replace_avatar) {
            const card = JSON.parse(data);
            card.chat = request.libraryReplacementChat;
            card.create_date = request.libraryReplacementCreateDate;
            data = JSON.stringify(card);
        }
        const outputImage = write(inputImage, data);`);
    source = replace(source, "            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);",
        "            await globalThis[Symbol.for('st.character-library.invalidate')](request.user.directories, preservedFileName + '.png');");
    // These paths all refer to the request's original Multer file. The wrapper
    // owns its lifetime, including rejection before the native handler runs.
    source = source.replace(/^ +(?:fs\.unlinkSync\(uploadPath\)|await fsPromises\.unlink\(uploadPath\)|fs\.unlinkSync\(newAvatarPath\));\n/gm, '');
    for (const next of ['/rename', '/duplicate']) {
        const end = source.indexOf("router.post('" + next + "'");
        const start = source.lastIndexOf('} catch (err) {', end);
        if (end < 0 || start < 0) throw Error('Missing create/import error handler');
        source = source.slice(0, start) + source.slice(start).replace('} catch (err) {', '} catch (err) {\n        if (err.status === 409) return sendLibraryConflict(response, err);');
    }
    source = replace(source, 'while (fs.existsSync(newFilename))', 'while (fs.existsSync(newFilename) || isReserved(request.user.directories, path.basename(newFilename)))');
    source = replace(source, '        fs.copyFileSync(filename, newFilename);', '        checkNewAvatar(request.user.directories, path.basename(newFilename));\n        fs.copyFileSync(filename, newFilename);');
    source = replace(source, '        await writeCharacterData(oldAvatarPath, newData, newInternalName, request);',
        '        if (!await writeCharacterData(oldAvatarPath, newData, newInternalName, request)) return response.sendStatus(500);');
    source = replace(source, '        // Return new avatar name to ST',
        '        await library()?.renamed(request.user.directories, oldAvatarName, newAvatarName);\n        // Return new avatar name to ST');
    return source;
}
