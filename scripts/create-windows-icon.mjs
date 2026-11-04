import { readFile, writeFile } from 'node:fs/promises';

// ICO supports a PNG-compressed image. Keep the source SVG as the editable asset.
const png = await readFile(new URL('../src-tauri/icons/256x256.png', import.meta.url));
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); // Image type: icon.
header.writeUInt16LE(1, 4); // One 256px image (zero in the width/height bytes).
header.writeUInt16LE(1, 10); // Planes.
header.writeUInt16LE(32, 12); // Bits per pixel.
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(header.length, 18);
await writeFile(new URL('../src-tauri/icons/icon.ico', import.meta.url), Buffer.concat([header, png]));
