'use strict';
// Deliverable generation: valid DOCX/XLSX/PPTX/PDF/code using stdlib only.
// OOXML files are real ZIPs (zlib deflate + hand-built central directory) so
// Word/Excel/PowerPoint open them. No external libs, fully offline.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- minimal ZIP writer (stored + deflated) ----
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    crc32._t = table;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
}

function buildZip(files) {
  // files: [{ name, data: Buffer }]
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, comp);
    central.push({ nameBuf, crc, compLen: comp.length, uncompLen: data.length, offset });
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.compLen, 20);
    ch.writeUInt32LE(c.uncompLen, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(c.offset, 42);
    parts.push(ch, c.nameBuf);
    cdSize += 46 + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8); end.writeUInt16LE(0, 10);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const RELS_XL = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const RELS_PP = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;

function createPdf(text, outPath) {
  ensureDir(path.dirname(outPath));
  const lines = String(text).split('\n').slice(0, 60);
  let content = 'BT /F1 11 Tf 50 780 Td 14 TL ';
  for (const ln of lines) {
    const clean = ln.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').slice(0, 120);
    content += `(${clean}) Tj T* `;
  }
  content += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(outPath, pdf, 'latin1');
  return outPath;
}

function createDocx(paragraphs, outPath, title = 'Sovereign Report') {
  ensureDir(path.dirname(outPath));
  const paras = (Array.isArray(paragraphs) ? paragraphs : [paragraphs]).map((p) =>
    `<w:p><w:r><w:t xml:space="preserve">${escXml(p)}</w:t></w:r></w:p>`).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:b/><w:sz w:val="28"/><w:t xml:space="preserve">${escXml(title)}</w:t></w:r></w:p>${paras}<w:sectPr/></w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const zip = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(RELS) },
    { name: 'word/document.xml', data: Buffer.from(doc) },
  ]);
  fs.writeFileSync(outPath, zip);
  return outPath;
}

function createXlsx(rows, outPath, sheetName = 'Sheet1') {
  ensureDir(path.dirname(outPath));
  const strings = [];
  const sIdx = new Map();
  const cellRef = (r, c) => String.fromCharCode(65 + c) + (r + 1);
  const getStr = (s) => {
    if (!sIdx.has(s)) { sIdx.set(s, strings.length); strings.push(s); }
    return sIdx.get(s);
  };
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((v, c) => {
      if (typeof v === 'number') return `<c r="${cellRef(r, c)}"><v>${v}</v></c>`;
      const i = getStr(String(v));
      return `<c r="${cellRef(r, c)}" t="s"><v>${i}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${escXml(s)}</t></si>`).join('')}</sst>`;
  const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRel = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const zip = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(RELS_XL) },
    { name: 'xl/workbook.xml', data: Buffer.from(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(wbRel) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sst) },
  ]);
  fs.writeFileSync(outPath, zip);
  return outPath;
}

function createPptx(slides, outPath, title = 'Sovereign Brief') {
  ensureDir(path.dirname(outPath));
  const items = (Array.isArray(slides) ? slides : [slides]).map((s) => `<a:p><a:r><a:t>${escXml(s)}</a:t></a:r></a:p>`).join('');
  const slide = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:rPr b="1" sz="2400"/><a:t>${escXml(title)}</a:t></a:r></a:p>${items}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const pres = `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  const presRel = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`;
  const zip = buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(ct) },
    { name: '_rels/.rels', data: Buffer.from(RELS_PP) },
    { name: 'ppt/presentation.xml', data: Buffer.from(pres) },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from(presRel) },
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slide) },
  ]);
  fs.writeFileSync(outPath, zip);
  return outPath;
}

function createCode(filename, content, outDir) {
  ensureDir(outDir);
  const p = path.join(outDir, filename);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

module.exports = { createPdf, createDocx, createXlsx, createPptx, createCode, buildZip };
