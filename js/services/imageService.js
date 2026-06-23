/**
 * imageService — local-first image gallery/editor data layer.
 * Stores uploaded/generated/edited images in IndexedDB so media can be
 * reopened, organized, attached, and exported without re-uploading.
 */
import { putRecord, getRecord, getAllRecords, deleteRecord, getRecordsByIndex } from './idbStore.js';

const IMAGE_STORE = 'images';
const FOLDER_STORE = 'imageFolders';
const VERSION_STORE = 'imageVersions';
const THUMB_SIZE = 360;
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function now() { return new Date().toISOString(); }
function id(prefix = 'img') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`; }
function clean(value) { return String(value || '').trim(); }
function list(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean);
    return String(value || '').split(/[\n,;#]/).map(clean).filter(Boolean);
}
function unique(values) { return Array.from(new Set(list(values).map(v => v.toLowerCase()))); }

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

async function makeThumbnail(dataUrl, size = THUMB_SIZE) {
    const img = await loadImage(dataUrl);
    const ratio = Math.min(size / img.width, size / img.height, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * ratio));
    canvas.height = Math.max(1, Math.round(img.height * ratio));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { thumbnailDataUrl: canvas.toDataURL('image/jpeg', 0.78), width: img.width, height: img.height };
}

export async function normalizeImage(input = {}, existing = null) {
    const ts = now();
    const dataUrl = input.dataUrl || existing?.dataUrl || '';
    const thumb = dataUrl && (!existing || input.dataUrl !== existing.dataUrl)
        ? await makeThumbnail(dataUrl)
        : { thumbnailDataUrl: existing?.thumbnailDataUrl || dataUrl, width: existing?.width || 0, height: existing?.height || 0 };
    return {
        id: input.id || existing?.id || id('image'),
        title: clean(input.title || existing?.title || input.fileName || 'Untitled Image'),
        description: clean(input.description || existing?.description || ''),
        dataUrl,
        thumbnailDataUrl: input.thumbnailDataUrl || thumb.thumbnailDataUrl,
        mimeType: input.mimeType || existing?.mimeType || (dataUrl.match(/^data:([^;]+);/)?.[1] || 'image/png'),
        fileName: clean(input.fileName || existing?.fileName || ''),
        sizeBytes: Number(input.sizeBytes ?? existing?.sizeBytes ?? 0),
        width: Number(input.width || thumb.width || existing?.width || 0),
        height: Number(input.height || thumb.height || existing?.height || 0),
        sourceType: clean(input.sourceType || existing?.sourceType || 'upload'),
        sourceSession: clean(input.sourceSession || existing?.sourceSession || ''),
        sourceChatId: clean(input.sourceChatId || existing?.sourceChatId || ''),
        prompt: clean(input.prompt || existing?.prompt || ''),
        model: clean(input.model || existing?.model || ''),
        projectId: clean(input.projectId || existing?.projectId || ''),
        folderId: clean(input.folderId || existing?.folderId || ''),
        tags: unique([...(existing?.tags || []), ...list(input.tags)]),
        favorite: Boolean(input.favorite ?? existing?.favorite ?? false),
        archived: Boolean(input.archived ?? existing?.archived ?? false),
        editHistory: Array.isArray(input.editHistory) ? input.editHistory : (existing?.editHistory || []),
        createdAt: existing?.createdAt || input.createdAt || ts,
        updatedAt: ts
    };
}

export async function importImageFiles(files, metadata = {}) {
    const imported = [];
    for (const file of Array.from(files || [])) {
        if (!file.type?.startsWith('image/')) continue;
        if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 24 MB`);
        const dataUrl = await fileToDataUrl(file);
        const image = await saveImage({
            ...metadata,
            dataUrl,
            title: metadata.title || file.name.replace(/\.[^.]+$/, ''),
            fileName: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            sourceType: metadata.sourceType || 'upload'
        });
        await addImageVersion(image.id, { dataUrl, label: 'Original import', editType: 'import' });
        imported.push(image);
    }
    return imported;
}

export async function listImages({ query = '', folderId = '', projectId = '', includeArchived = false, sourceType = '' } = {}) {
    const q = clean(query).toLowerCase();
    const images = await getAllRecords(IMAGE_STORE);
    return images
        .filter(img => includeArchived || !img.archived)
        .filter(img => !folderId || img.folderId === folderId)
        .filter(img => !projectId || img.projectId === projectId)
        .filter(img => !sourceType || img.sourceType === sourceType)
        .filter(img => !q || [img.title, img.description, img.prompt, img.model, img.sourceSession, img.fileName, ...(img.tags || [])].join(' ').toLowerCase().includes(q))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function getImage(imageId) { return getRecord(IMAGE_STORE, imageId); }
export async function saveImage(input) {
    const existing = input.id ? await getImage(input.id) : null;
    const image = await normalizeImage(input, existing);
    await putRecord(IMAGE_STORE, image);
    return image;
}
export async function removeImage(imageId) {
    const versions = await listImageVersions(imageId);
    await Promise.all(versions.map(v => deleteRecord(VERSION_STORE, v.id)));
    await deleteRecord(IMAGE_STORE, imageId);
}
export async function archiveImage(imageId, archived = true) {
    const image = await getImage(imageId);
    return image ? saveImage({ ...image, archived }) : null;
}

export async function listFolders() {
    return (await getAllRecords(FOLDER_STORE)).sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
}
export async function saveFolder(input = {}) {
    const folder = { id: input.id || id('folder'), name: clean(input.name || 'New Folder'), projectId: clean(input.projectId || ''), createdAt: input.createdAt || now(), updatedAt: now() };
    await putRecord(FOLDER_STORE, folder);
    return folder;
}
export async function deleteFolder(folderId) {
    const images = await getRecordsByIndex(IMAGE_STORE, 'folderId', folderId);
    await Promise.all(images.map(image => saveImage({ ...image, folderId: '' })));
    await deleteRecord(FOLDER_STORE, folderId);
}

export async function addImageVersion(imageId, { dataUrl, label = 'Edited version', editType = 'edit', prompt = '', operations = [] } = {}) {
    const image = await getImage(imageId);
    if (!image) throw new Error('Image not found');
    const thumb = await makeThumbnail(dataUrl || image.dataUrl);
    const version = {
        id: id('image_version'), imageId, label: clean(label), editType: clean(editType), prompt: clean(prompt), operations,
        dataUrl: dataUrl || image.dataUrl, thumbnailDataUrl: thumb.thumbnailDataUrl, width: thumb.width, height: thumb.height, createdAt: now()
    };
    await putRecord(VERSION_STORE, version);
    const history = [...(image.editHistory || []), { versionId: version.id, label: version.label, editType: version.editType, prompt: version.prompt, createdAt: version.createdAt }];
    await saveImage({ ...image, dataUrl: version.dataUrl, thumbnailDataUrl: version.thumbnailDataUrl, width: version.width, height: version.height, editHistory: history });
    return version;
}
export async function listImageVersions(imageId) {
    return (await getRecordsByIndex(VERSION_STORE, 'imageId', imageId)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export async function restoreImageVersion(imageId, versionId) {
    const image = await getImage(imageId);
    const version = await getRecord(VERSION_STORE, versionId);
    if (!image || !version) throw new Error('Image version not found');
    return saveImage({ ...image, dataUrl: version.dataUrl, thumbnailDataUrl: version.thumbnailDataUrl, width: version.width, height: version.height });
}

export function downloadDataUrl(dataUrl, filename = 'image.png') {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export async function exportBundle(imageIds = []) {
    const images = (await Promise.all(imageIds.map(getImage))).filter(Boolean);
    const bundle = {
        exportedAt: now(),
        type: 'synapse-image-bundle-v1',
        images: images.map(({ id, title, description, prompt, model, sourceType, sourceSession, sourceChatId, projectId, folderId, tags, createdAt, updatedAt, width, height, mimeType, dataUrl }) => ({
            id, title, description, prompt, model, sourceType, sourceSession, sourceChatId, projectId, folderId, tags, createdAt, updatedAt, width, height, mimeType, dataUrl
        }))
    };
    const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(bundle, null, 2))}`;
    downloadDataUrl(dataUrl, `synapse-image-bundle-${Date.now()}.json`);
    return bundle;
}

export function imageMarkdown(image = {}) {
    return `![${image.title || 'Synapse image'}](${image.dataUrl || image.thumbnailDataUrl || ''})`;
}

export const imageService = {
    importImageFiles, listImages, getImage, saveImage, removeImage, archiveImage,
    listFolders, saveFolder, deleteFolder,
    addImageVersion, listImageVersions, restoreImageVersion,
    exportBundle, downloadDataUrl, imageMarkdown
};
