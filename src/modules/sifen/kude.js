// src/modules/sifen/kude.js
// Generador de KUDE - Layout estandar SIFEN Paraguay
// Soporte de logo por tenant desde Supabase Storage
// Formatos: A4, Ticket 80mm, Ticket 58mm

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// ── Colores ───────────────────────────────────────────────────────────────────
const C_NEGRO      = rgb(0.08, 0.08, 0.08)
const C_GRIS       = rgb(0.40, 0.40, 0.40)
const C_GRIS_CLARO = rgb(0.94, 0.94, 0.94)
const C_BLANCO     = rgb(1, 1, 1)
const C_BORDE      = rgb(0.65, 0.65, 0.65)
const C_VERDE      = rgb(0.10, 0.50, 0.10)
const C_ROJO       = rgb(0.70, 0.10, 0.10)
const C_HEADER     = rgb(0.25, 0.25, 0.25)

// ── Tipos de documento ────────────────────────────────────────────────────────
const TIPOS_DOC = {
  1: 'FACTURA ELECTRONICA',
  2: 'FACTURA ELECTRONICA DE EXPORTACION',
  3: 'FACTURA ELECTRONICA DE IMPORTACION',
  4: 'AUTOFACTURA ELECTRONICA',
  5: 'NOTA DE CREDITO ELECTRONICA',
  6: 'NOTA DE DEBITO ELECTRONICA',
  7: 'NOTA DE REMISION ELECTRONICA',
}

// ── Helpers de datos ──────────────────────────────────────────────────────────
function parsePayload(doc) {
  if (!doc.payloadJson) return {}
  if (typeof doc.payloadJson === 'string') {
    try { return JSON.parse(doc.payloadJson) } catch (e) { return {} }
  }
  return doc.payloadJson
}

function parseActEco(tenant) {
  try {
    const acts = typeof tenant.actividadesEconomicas === 'string'
      ? JSON.parse(tenant.actividadesEconomicas)
      : (tenant.actividadesEconomicas || [])
    return Array.isArray(acts) ? acts : []
  } catch (e) { return [] }
}

function tipoDocRec(tipo) {
  if (tipo === 1) return 'RUC'
  if (tipo === 2) return 'Pasaporte'
  if (tipo === 3) return 'C.I.'
  return ''
}

function formatNum(valor, moneda = 'PYG') {
  if (!valor && valor !== 0) return '0'
  const n = Number(valor)
  if (moneda === 'PYG') return n.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  return n.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fFecha(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}

function fHora(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

function fCDC(str) {
  if (!str) return ''
  return str.replace(/(.{4})/g, '$1 ').trim()
}

function trunc(text, max) {
  const t = String(text ?? '')
  return t.length > max ? t.substring(0, max - 2) + '..' : t
}

function numALetras(n) {
  const num = Math.round(Number(n) || 0)
  if (num === 0) return 'CERO'
  const u = ['','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE',
    'DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISEIS','DIECISIETE','DIECIOCHO','DIECINUEVE']
  const d = ['','','VEINTE','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA']
  const c = ['','CIEN','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS',
    'SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS']
  function g(n) {
    let s = ''
    if (n >= 100) { s += c[Math.floor(n/100)] + (n%100>0?' ':''); n=n%100 }
    if (n >= 20)  { s += d[Math.floor(n/10)]  + (n%10>0?' Y ':''); n=n%10 }
    if (n > 0)    { s += u[n] }
    return s.trim()
  }
  if (num < 1000) return g(num)
  if (num < 1000000) {
    const m = Math.floor(num/1000), r = num%1000
    return (m===1?'MIL':g(m)+' MIL') + (r>0?' '+g(r):'')
  }
  const m = Math.floor(num/1000000), r = num%1000000
  return (m===1?'UN MILLON':g(m)+' MILLONES') + (r>0?' '+numALetras(r):'')
}

async function fetchLogo(url) {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch (e) { return null }
}

async function embedLogo(pdfDoc, logoUrl) {
  if (!logoUrl) return null
  try {
    const bytes = await fetchLogo(logoUrl)
    if (!bytes) return null
    try { return await pdfDoc.embedPng(bytes) } catch (e) {
      try { return await pdfDoc.embedJpg(bytes) } catch (e2) { return null }
    }
  } catch (e) { return null }
}

function embedQR(pdfDoc, qrBase64) {
  if (!qrBase64) return null
  try {
    const b64   = String(qrBase64).replace(/^data:image\/png;base64,/, '')
    const bytes = Buffer.from(b64, 'base64')
    return pdfDoc.embedPng(bytes)
  } catch (e) { return null }
}

// ══════════════════════════════════════════════════════════════════════════════
// KUDE A4
// ══════════════════════════════════════════════════════════════════════════════
export async function generarKudeA4(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595, 842])
  const W595   = 595
  const H842   = 842

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const M = 25
  const W = W595 - M * 2   // 545
  let y   = H842 - M       // 817

  // ── Helpers ────────────────────────────────────────────────────────────────
  const t = (text, x, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    page.drawText(s, { x, y: yy, size, font, color })
  }
  const tR = (text, xRight, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y: yy, size, font, color })
  }
  const tC = (text, x1, x2, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: x1 + (x2 - x1 - w) / 2, y: yy, size, font, color })
  }
  const ln = (x1, y1, x2, y2, th = 0.4, col = C_BORDE) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color: col })
  const bx = (x, yy, w, h, opts = {}) => {
    const o = { x, y: yy, width: w, height: h, borderWidth: opts.bw ?? 0.4, opacity: 1 }
    if (opts.fill)   o.color       = opts.fill
    if (opts.border) o.borderColor = opts.border
    page.drawRectangle(o)
  }

  const payload  = parsePayload(doc)
  const items    = payload.items    || []
  const receptor = payload.receptor || {}
  const tipoDoc  = doc.tipoDocumento || 1
  const moneda   = payload.moneda   || 'PYG'
  const actEcos  = parseActEco(tenant)

  // ── CABECERA ────────────────────────────────────────────────────────────────
  const logoColW = W * 0.52
  const timColX  = M + logoColW
  const hH       = 82

  bx(M, y - hH, W, hH, { border: C_BORDE })
  ln(timColX, y, timColX, y - hH)

  // Logo - se dibuja arriba y los textos van debajo del logo
  const logoImg = await embedLogo(pdfDoc, tenant.logoUrl || tenant.logo_url)
  let logoBottomY = y - 6   // posicion donde termina el logo (o top si no hay logo)
  if (logoImg) {
    const maxH = 28, maxW = logoColW * 0.55
    const dims = logoImg.scale(1)
    const sc   = Math.min(maxW / dims.width, maxH / dims.height)
    const lw   = dims.width * sc
    const lh   = dims.height * sc
    page.drawImage(logoImg, { x: M + 8, y: y - 6 - lh, width: lw, height: lh })
    logoBottomY = y - 6 - lh - 4   // 4pt de margen bajo el logo
  }

  // Datos emisor - empiezan justo debajo del logo
  t(trunc(tenant.razonSocial || tenant.razon_social || '', 46), M + 8, logoBottomY - 0,  { font: fBold, size: 8 })
  t(`RUC: ${tenant.ruc || ''}`, M + 8, logoBottomY - 11, { font: fBold, size: 7.5 })
  t(trunc(tenant.direccion || '', 56), M + 8, logoBottomY - 21, { size: 7 })

  // Actividades economicas
  let actY = logoBottomY - 31
  for (const act of actEcos) {
    t(trunc((act.descripcion || '') + '.', 60), M + 8, actY, { size: 6.5, color: C_GRIS })
    actY -= 9
  }
  if (tenant.telefono || tenant.email) {
    t(trunc([tenant.telefono, tenant.email].filter(Boolean).join(' | '), 60), M + 8, actY, { size: 6.5, color: C_GRIS })
  }

  // Timbrado derecha
  const rx = timColX + 6
  const rw = M + W - 4
  t('Timbrado', rx, y - 10, { font: fBold, size: 7 })
  tR(String(doc.timbradoNumero || ''), rw, y - 10, { font: fBold, size: 8 })
  t('Fecha Inicio de Vigencia:', rx, y - 22, { size: 7 })
  tR(fFecha(doc.timbradoVigenciaDesde || ''), rw, y - 22, { size: 7 })
  ln(timColX, y - 32, M + W, y - 32)
  tC(TIPOS_DOC[tipoDoc] || 'DOCUMENTO ELECTRONICO', timColX, M + W, y - 44, { font: fBold, size: 9 })
  tC(`N° ${doc.numero || ''}`, timColX, M + W, y - 58, { font: fBold, size: 10 })

  y -= hH

  // ── DATOS OPERACION + RECEPTOR ──────────────────────────────────────────────
  const datH    = 82
  const datColW = W * 0.48
  const datDivX = M + datColW

  bx(M, y - datH, W, datH, { border: C_BORDE })
  ln(datDivX, y, datDivX, y - datH)

  // Columna izquierda
  const lx = M + 5
  t('Fecha y hora de emision:', lx, y - 9,  { font: fBold, size: 7 })
  t(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`, lx, y - 18, { size: 7.5 })
  t('Condicion Venta:',    lx, y - 31, { font: fBold, size: 7 })
  t('Contado',             lx + 74, y - 31, { size: 7 })
  t('Tipo de Transaccion:', lx, y - 43, { font: fBold, size: 7 })
  t('Venta de mercaderia', lx, y - 53, { size: 7, color: C_GRIS })
  t('Moneda:',             lx, y - 65, { font: fBold, size: 7 })
  t(moneda,                lx + 38, y - 65, { size: 7 })

  // Columna derecha - receptor
  const rx2 = datDivX + 5
  const tipR = tipoDocRec(receptor.tipo)
  if (tipR) {
    t(`${tipR}:`, rx2, y - 9, { font: fBold, size: 7 })
    t(receptor.documento || '', rx2 + 40, y - 9, { size: 7.5 })
  }
  t('Razon Social:', rx2, y - 22, { font: fBold, size: 7 })
  t(trunc(receptor.razonSocial || 'CONSUMIDOR FINAL', 38), rx2, y - 32, { size: 7.5 })
  if (receptor.email) {
    t('Email:', rx2, y - 45, { font: fBold, size: 7 })
    t(trunc(receptor.email, 38), rx2, y - 55, { size: 7 })
  }
  if (receptor.celular) {
    t('Celular:', rx2, y - 67, { font: fBold, size: 7 })
    t(receptor.celular, rx2 + 40, y - 67, { size: 7 })
  }

  y -= datH

  // ── TABLA DE ITEMS ──────────────────────────────────────────────────────────
  const cols = [
    { label: 'Cod.',         x: M,             w: W*0.065, a: 'c' },
    { label: 'Descripcion',  x: M + W*0.065,   w: W*0.33,  a: 'l' },
    { label: 'U.Med.',       x: M + W*0.395,   w: W*0.065, a: 'c' },
    { label: 'Cant.',        x: M + W*0.46,    w: W*0.065, a: 'r' },
    { label: 'Precio Unit.', x: M + W*0.525,   w: W*0.12,  a: 'r' },
    { label: 'Desc/Antic.',  x: M + W*0.645,   w: W*0.085, a: 'r' },
    { label: 'Exentas',      x: M + W*0.73,    w: W*0.09,  a: 'r' },
    { label: '5%',           x: M + W*0.82,    w: W*0.085, a: 'r' },
    { label: '10%',          x: M + W*0.905,   w: W*0.095, a: 'r' },
  ]

  const thH  = 14
  const rowH = 12

  // Header tabla
  bx(M, y - thH, W, thH, { fill: C_HEADER })
  for (const col of cols) {
    if      (col.a === 'c') tC(col.label, col.x, col.x + col.w, y - 5, { font: fBold, size: 6, color: C_BLANCO })
    else if (col.a === 'r') tR(col.label, col.x + col.w - 2, y - 5, { font: fBold, size: 6, color: C_BLANCO })
    else                    t(col.label,  col.x + 2, y - 5, { font: fBold, size: 6, color: C_BLANCO })
    ln(col.x, y, col.x, y - thH, 0.3, C_BLANCO)
  }
  ln(M + W, y, M + W, y - thH, 0.3, C_BLANCO)
  y -= thH

  // Calcular totales desde items
  let totEx = 0, totG5 = 0, totG10 = 0
  for (const item of items) {
    const n = Number(item.precioTotal)
    if (item.tasaIVA === 0)  totEx  += n
    if (item.tasaIVA === 5)  totG5  += n
    if (item.tasaIVA === 10) totG10 += n
  }

  // Filas items
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (i % 2 === 0) bx(M, y - rowH, W, rowH, { fill: C_GRIS_CLARO })
    const ex = item.tasaIVA === 0  ? Number(item.precioTotal) : 0
    const g5 = item.tasaIVA === 5  ? Number(item.precioTotal) : 0
    const g10= item.tasaIVA === 10 ? Number(item.precioTotal) : 0
    tC(String(i+1).padStart(3,'0'), cols[0].x, cols[0].x+cols[0].w, y-8, { size: 6.5 })
    t(trunc(item.descripcion||'', 44), cols[1].x+2, y-8, { size: 6.5 })
    tC('UNI', cols[2].x, cols[2].x+cols[2].w, y-8, { size: 6.5 })
    tR(String(item.cantidad), cols[3].x+cols[3].w-2, y-8, { size: 6.5 })
    tR(formatNum(item.precioUnitario,moneda), cols[4].x+cols[4].w-2, y-8, { size: 6.5 })
    tR('0', cols[5].x+cols[5].w-2, y-8, { size: 6.5 })
    tR(ex>0?formatNum(ex,moneda):'0', cols[6].x+cols[6].w-2, y-8, { size: 6.5 })
    tR(g5>0?formatNum(g5,moneda):'0', cols[7].x+cols[7].w-2, y-8, { size: 6.5 })
    tR(g10>0?formatNum(g10,moneda):'0', cols[8].x+cols[8].w-2, y-8, { size: 6.5 })
    // Solo bordes exteriores y línea inferior — sin verticales internas
    ln(M, y, M, y-rowH, 0.3, C_BORDE)
    ln(M+W, y, M+W, y-rowH, 0.3, C_BORDE)
    ln(M, y-rowH, M+W, y-rowH, 0.3, C_BORDE)
    y -= rowH
  }

  // Filas vacías mínimo 5 — sin cuadrícula
  for (let i = 0; i < Math.max(0, 5 - items.length); i++) {
    ln(M, y, M, y-rowH, 0.3, C_BORDE)
    ln(M+W, y, M+W, y-rowH, 0.3, C_BORDE)
    ln(M, y-rowH, M+W, y-rowH, 0.3, C_BORDE)
    y -= rowH
  }

  // ── SUBTOTALES ──────────────────────────────────────────────────────────────
  const totalGen = totEx + totG5 + totG10 || Number(doc.montoTotal) || 0
  const iva5amt  = Number(doc.montoIva5)  || 0
  const iva10amt = Number(doc.montoIva10) || 0
  const stH = 13

  // Columnas de subtotales alineadas con tabla
  const stEx  = cols[6], stG5 = cols[7], stG10 = cols[8]

  bx(M, y-stH, W, stH, { fill: C_GRIS_CLARO, border: C_BORDE })
  t('SUBTOTALES:', M+5, y-8, { font: fBold, size: 7 })
  ln(stEx.x,  y, stEx.x,  y-stH, 0.3, C_BORDE)
  ln(stG5.x,  y, stG5.x,  y-stH, 0.3, C_BORDE)
  ln(stG10.x, y, stG10.x, y-stH, 0.3, C_BORDE)
  ln(M+W, y, M+W, y-stH, 0.3, C_BORDE)
  tR(formatNum(totEx,moneda),  stEx.x +stEx.w -2, y-8, { size: 7 })
  tR(formatNum(totG5,moneda),  stG5.x +stG5.w -2, y-8, { size: 7 })
  tR(formatNum(totG10,moneda), stG10.x+stG10.w-2, y-8, { size: 7 })
  y -= stH

  bx(M, y-stH, W, stH, { border: C_BORDE })
  t('SUMA TOTAL:', M+5, y-8, { font: fBold, size: 7 })
  tR(formatNum(totalGen, moneda), M+W-4, y-8, { font: fBold, size: 8 })
  y -= stH

  bx(M, y-stH, W, stH, { border: C_BORDE })
  t('DESCUENTO/ANTICIPO GLOBAL:', M+5, y-8, { size: 7 })
  tR('0', M+W-4, y-8, { size: 7 })
  y -= stH

  bx(M, y-stH, W, stH, { fill: C_HEADER, border: C_BORDE })
  t('TOTAL DE LA OPERACION:', M+5, y-8, { font: fBold, size: 8, color: C_BLANCO })
  tR(formatNum(totalGen, moneda), M+W-4, y-8, { font: fBold, size: 9, color: C_BLANCO })
  y -= stH

  bx(M, y-stH, W, stH, { border: C_BORDE })
  t('EN LETRAS: GUARANIES ' + numALetras(totalGen), M+5, y-8, { size: 6.5, color: C_GRIS })
  y -= stH

  // Liquidacion IVA
  const ivaH = 16
  bx(M, y-ivaH, W, ivaH, { border: C_BORDE })
  t('LIQUIDACION IVA:', M+5, y-5, { font: fBold, size: 7 })
  t(`(5%)  ${formatNum(iva5amt, moneda)}`, M+5, y-13, { size: 7 })
  t(`(10%)  ${formatNum(iva10amt, moneda)}`, M + W/3, y-13, { size: 7 })
  t(`Total IVA:  ${formatNum(iva5amt+iva10amt, moneda)}`, M + W*2/3, y-13, { font: fBold, size: 7 })
  y -= ivaH

  // ── QR + CDC ────────────────────────────────────────────────────────────────
  y -= 10
  const qrSize = 80
  const cdcX   = M + qrSize + 12

  // QR
  try {
    const qrImg = await embedQR(pdfDoc, qrBase64)
    if (qrImg) page.drawImage(qrImg, { x: M, y: y-qrSize, width: qrSize, height: qrSize })
  } catch (e) { /* sin QR */ }

  // Texto CDC
  t('Consulte la validez de este Documento Electronico con el numero de CDC impreso', cdcX, y-8, { size: 6.5, color: C_GRIS })
  t('https://ekuatia.set.gov.py/consultas', cdcX, y-17, { size: 6.5, color: C_GRIS })
  t('CDC:', cdcX, y-30, { font: fBold, size: 7 })

  // CDC en dos lineas de 22 chars del CDC original
  const cdcRaw = doc.cdc || ''
  t(fCDC(cdcRaw.substring(0, 22)),  cdcX, y-41, { font: fBold, size: 8 })
  t(fCDC(cdcRaw.substring(22)),     cdcX, y-52, { font: fBold, size: 8 })

  const estadoColor = doc.estado === 'aprobado' ? C_VERDE : C_ROJO
  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO POR LA SET' : (doc.estado||'').toUpperCase()
  t(estadoTxt, cdcX, y-65, { font: fBold, size: 8.5, color: estadoColor })
  if (doc.estado === 'aprobado') {
    t(`Fecha: ${fFecha(doc.sifenRespEn)} ${fHora(doc.sifenRespEn)}`, cdcX, y-75, { size: 7, color: C_GRIS })
  }

  y -= qrSize + 12

  // Pie
  ln(M, y, M+W, y, 0.5, C_BORDE)
  y -= 9
  t('Si su documento electronico presenta algun error puede solicitar la modificacion dentro de las 72 horas siguientes de la emision de este comprobante.', M, y, { size: 5.8, color: C_GRIS })
  y -= 9
  t('ESTE DOCUMENTO ES UNA REPRESENTACION GRAFICA DE UN DOCUMENTO ELECTRONICO (XML)', M, y, { font: fBold, size: 6.5 })
  y -= 9
  t('Generado por NODO - Plataforma de Facturacion Electronica Paraguay | nodo.com.py', M, y, { size: 6, color: C_GRIS })

  return pdfDoc.save()
}

// ══════════════════════════════════════════════════════════════════════════════
// KUDE TICKET 58mm
// ══════════════════════════════════════════════════════════════════════════════
export async function generarKudeTicket58(doc, tenant, qrBase64 = null) {
  const pdfDoc  = await PDFDocument.create()
  const mmToPt  = mm => mm * 2.8346
  const PW      = mmToPt(58)   // 164pt
  const payload = parsePayload(doc)
  const items   = payload.items    || []
  const recep   = payload.receptor || {}
  const moneda  = payload.moneda   || 'PYG'
  const tipoDoc = doc.tipoDocumento || 1
  const actEcos = parseActEco(tenant)

  // Altura dinámica
  const qrH   = qrBase64 ? PW + 10 : 0
  const PH    = 280 + items.length * 24 + actEcos.length * 9 + qrH
  const page  = pdfDoc.addPage([PW, PH])

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const MG = 5
  let y    = PH - MG
  const MW = PW - MG * 2

  const t = (text, x, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    page.drawText(s, { x, y: yy, size, font, color })
  }
  const tC = (text, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: Math.max(MG, (PW-w)/2), y: yy, size, font, color })
  }
  const tR = (text, xR, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? ''); if (!s) return
    page.drawText(s, { x: xR - font.widthOfTextAtSize(s,size), y: yy, size, font, color })
  }
  const ln = (y1) => page.drawLine({ start:{x:MG,y:y1}, end:{x:PW-MG,y:y1}, thickness:0.4, color:C_BORDE })
  const trA = (text, font, size) => {
    let s = String(text??'')
    while (s.length>0 && font.widthOfTextAtSize(s,size)>MW) s=s.slice(0,-1)
    return s
  }

  // Logo
  const logoImg58 = await embedLogo(pdfDoc, tenant.logoUrl || tenant.logo_url)
  if (logoImg58) {
    const maxH=26, maxW=PW*0.60, dims=logoImg58.scale(1)
    const sc=Math.min(maxW/dims.width, maxH/dims.height)
    const lw=dims.width*sc, lh=dims.height*sc
    page.drawImage(logoImg58, { x:(PW-lw)/2, y:y-lh, width:lw, height:lh })
    y -= lh + 5
  }

  // Cabecera
  tC(trA(tenant.razonSocial||tenant.razon_social||'', fBold, 8), y-9, { font:fBold, size:8 }); y-=12
  tC(`RUC: ${tenant.ruc||''}`, y-7, { size:7 }); y-=9
  tC(trA(tenant.direccion||'', fReg, 6.5), y-7, { size:6.5, color:C_GRIS }); y-=9
  for (const act of actEcos) {
    tC(trA((act.descripcion||''), fReg, 6), y-6, { size:6, color:C_GRIS }); y-=8
  }
  ln(y); y-=5

  tC(TIPOS_DOC[tipoDoc]||'DOC. ELECTRONICO', y-7, { font:fBold, size:7.5 }); y-=10
  tC(`N° ${doc.numero||''}`, y-7, { font:fBold, size:9 }); y-=12
  tC(`Timbrado: ${doc.timbradoNumero||''}`, y-7, { size:6.5 }); y-=9
  tC(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`, y-7, { size:7 }); y-=10

  ln(y); y-=5
  const eTxt   = doc.estado==='aprobado'?'APROBADO SET':(doc.estado||'').toUpperCase()
  const eColor = doc.estado==='aprobado'?C_VERDE:C_ROJO
  tC(eTxt, y-7, { font:fBold, size:8, color:eColor }); y-=11
  ln(y); y-=5

  // Receptor
  const tipR58 = tipoDocRec(recep.tipo)
  if (tipR58 && recep.documento) { t(`${tipR58}: ${recep.documento}`, MG, y-7, { size:6.5 }); y-=9 }
  if (recep.razonSocial) { t(trA(`Cliente: ${recep.razonSocial}`, fReg, 6.5), MG, y-7, { size:6.5 }); y-=9 }
  ln(y); y-=4

  // Header items
  t('Descripcion', MG, y-7, { font:fBold, size:6.5 })
  tR('Total', PW-MG, y-7, { font:fBold, size:6.5 })
  y-=9; ln(y); y-=4

  // Items + calcular totales
  let totEx58=0, totG5_58=0, totG10_58=0
  for (const item of items) {
    const totalStr = formatNum(item.precioTotal, moneda)
    const totalW   = fReg.widthOfTextAtSize(totalStr, 7)
    const ivaStr   = `${item.tasaIVA}%`
    const ivaW     = fReg.widthOfTextAtSize(ivaStr, 6)
    let desc = String(item.descripcion||'')
    while (desc.length>0 && fReg.widthOfTextAtSize(desc,6.5)>MW-totalW-ivaW-8) desc=desc.slice(0,-1)
    t(desc, MG, y-7, { size:6.5 })
    tR(ivaStr, PW-MG-totalW-3, y-7, { size:6, color:C_GRIS })
    tR(totalStr, PW-MG, y-7, { size:7 })
    y-=9
    const det = `${item.cantidad} x ${formatNum(item.precioUnitario,moneda)}`
    t(trA(det, fReg, 6), MG, y-7, { size:6, color:C_GRIS }); y-=9
    const n=Number(item.precioTotal)
    if (item.tasaIVA===0)  totEx58  +=n
    if (item.tasaIVA===5)  totG5_58 +=n
    if (item.tasaIVA===10) totG10_58+=n
  }

  const totalGen58 = totEx58+totG5_58+totG10_58 || Number(doc.montoTotal)||0
  const iva5_58    = Number(doc.montoIva5)  ||0
  const iva10_58   = Number(doc.montoIva10) ||0

  ln(y); y-=4

  const fila58 = (label, valor, bold=false) => {
    const f=bold?fBold:fReg, sz=bold?8.5:7
    t(label, MG, y-7, { font:f, size:sz })
    tR(String(valor), PW-MG, y-7, { font:f, size:sz })
    y -= bold?11:9
  }
  if (totEx58  >0) fila58('Exentas:',     formatNum(totEx58,   moneda))
  if (totG5_58 >0) { fila58('Gravadas 5%:', formatNum(totG5_58, moneda)); fila58('IVA 5%:', formatNum(iva5_58, moneda)) }
  if (totG10_58>0) { fila58('Gravadas 10%:',formatNum(totG10_58,moneda)); fila58('IVA 10%:',formatNum(iva10_58,moneda)) }
  ln(y); y-=3
  fila58(`TOTAL ${moneda}:`, formatNum(totalGen58, moneda), true)
  ln(y); y-=8

  // QR
  try {
    const qrImg58 = await embedQR(pdfDoc, qrBase64)
    if (qrImg58) {
      const qrSz = PW - MG*2
      page.drawImage(qrImg58, { x:MG, y:y-qrSz, width:qrSz, height:qrSz })
      y -= qrSz+5
      tC('Verificar en ekuatia.set.gov.py', y-7, { size:5.5, color:C_GRIS }); y-=9
    }
  } catch (e) { /* sin QR */ }

  // CDC en 4 lineas
  ln(y); y-=5
  tC('CDC:', y-7, { font:fBold, size:6 }); y-=9
  const cdc58 = doc.cdc||''
  tC(fCDC(cdc58.substring(0,12)),  y-6, { size:5.5 }); y-=8
  tC(fCDC(cdc58.substring(12,24)), y-6, { size:5.5 }); y-=8
  tC(fCDC(cdc58.substring(24,36)), y-6, { size:5.5 }); y-=8
  tC(fCDC(cdc58.substring(36)),    y-6, { size:5.5 }); y-=10
  ln(y); y-=6
  tC('NODO - Facturacion Electronica Paraguay', y-6, { size:5.5, color:C_GRIS })

  return pdfDoc.save()
}

// ══════════════════════════════════════════════════════════════════════════════
// KUDE TICKET 80mm
// ══════════════════════════════════════════════════════════════════════════════
export async function generarKudeTicket(doc, tenant, qrBase64 = null) {
  const pdfDoc  = await PDFDocument.create()
  const mmToPt  = mm => mm * 2.8346
  const PW      = mmToPt(80)
  const payload = parsePayload(doc)
  const items   = payload.items    || []
  const recep   = payload.receptor || {}
  const moneda  = payload.moneda   || 'PYG'
  const tipoDoc = doc.tipoDocumento || 1
  const actEcos = parseActEco(tenant)

  const qrH = qrBase64 ? PW + 10 : 0
  const PH  = 340 + items.length * 22 + actEcos.length * 9 + qrH
  const page= pdfDoc.addPage([PW, PH])

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const MG = 6
  let y    = PH - MG
  const MW = PW - MG * 2

  const t = (text, x, yy, opts = {}) => {
    const { font=fReg, size=7, color=C_NEGRO } = opts
    const s=String(text??''); if(!s) return
    page.drawText(s,{x,y:yy,size,font,color})
  }
  const tC = (text, yy, opts = {}) => {
    const { font=fReg, size=7, color=C_NEGRO } = opts
    const s=String(text??''); if(!s) return
    const w=font.widthOfTextAtSize(s,size)
    page.drawText(s,{x:Math.max(MG,(PW-w)/2),y:yy,size,font,color})
  }
  const tR = (text, xR, yy, opts = {}) => {
    const { font=fReg, size=7, color=C_NEGRO } = opts
    const s=String(text??''); if(!s) return
    page.drawText(s,{x:xR-font.widthOfTextAtSize(s,size),y:yy,size,font,color})
  }
  const ln = (y1) => page.drawLine({start:{x:MG,y:y1},end:{x:PW-MG,y:y1},thickness:0.4,color:C_BORDE})
  const trA = (text, font, size) => {
    let s=String(text??'')
    while(s.length>0&&font.widthOfTextAtSize(s,size)>MW) s=s.slice(0,-1)
    return s
  }

  // Logo
  const logoImg80 = await embedLogo(pdfDoc, tenant.logoUrl||tenant.logo_url)
  if (logoImg80) {
    const maxH=30, maxW=PW*0.65, dims=logoImg80.scale(1)
    const sc=Math.min(maxW/dims.width,maxH/dims.height)
    const lw=dims.width*sc, lh=dims.height*sc
    page.drawImage(logoImg80,{x:(PW-lw)/2,y:y-lh,width:lw,height:lh})
    y-=lh+5
  }

  tC(trA(tenant.razonSocial||tenant.razon_social||'',fBold,9),y-10,{font:fBold,size:9}); y-=13
  tC(`RUC: ${tenant.ruc||''}`,y-7,{size:7.5}); y-=10
  tC(trA(tenant.direccion||'',fReg,7),y-7,{size:7,color:C_GRIS}); y-=10
  for (const act of actEcos){tC(trA(act.descripcion||'',fReg,6.5),y-7,{size:6.5,color:C_GRIS});y-=9}

  ln(y); y-=6
  tC(TIPOS_DOC[tipoDoc]||'DOC. ELECTRONICO',y-7,{font:fBold,size:8}); y-=11
  tC(`N° ${doc.numero||''}`,y-7,{font:fBold,size:9.5}); y-=13
  tC(`Timbrado: ${doc.timbradoNumero||''}`,y-7,{size:7}); y-=9
  tC(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`,y-7,{size:7}); y-=11

  ln(y); y-=6
  const eTxt80   = doc.estado==='aprobado'?'APROBADO SET':(doc.estado||'').toUpperCase()
  const eColor80 = doc.estado==='aprobado'?C_VERDE:C_ROJO
  tC(eTxt80,y-7,{font:fBold,size:8,color:eColor80}); y-=11
  ln(y); y-=6

  const tipR80 = tipoDocRec(recep.tipo)
  if (tipR80&&recep.documento){t(`${tipR80}: ${recep.documento}`,MG,y-7,{size:7});y-=10}
  if (recep.razonSocial){t(trA(`Cliente: ${recep.razonSocial}`,fReg,7),MG,y-7,{size:7});y-=10}
  ln(y); y-=5

  t('Descripcion',MG,y-7,{font:fBold,size:7})
  tR('Total',PW-MG,y-7,{font:fBold,size:7})
  y-=9; ln(y); y-=4

  let totEx80=0, totG5_80=0, totG10_80=0
  for (const item of items){
    const totalStr=formatNum(item.precioTotal,moneda)
    const totalW  =fReg.widthOfTextAtSize(totalStr,7.5)
    let desc=String(item.descripcion||'')
    while(desc.length>0&&fReg.widthOfTextAtSize(desc,7)>MW-totalW-6) desc=desc.slice(0,-1)
    t(desc,MG,y-7,{size:7})
    tR(totalStr,PW-MG,y-7,{size:7.5})
    y-=10
    const det=`${item.cantidad} x ${formatNum(item.precioUnitario,moneda)} | IVA ${item.tasaIVA}%`
    t(trA(det,fReg,6.5),MG,y-7,{size:6.5,color:C_GRIS}); y-=10
    const n=Number(item.precioTotal)
    if(item.tasaIVA===0)  totEx80  +=n
    if(item.tasaIVA===5)  totG5_80 +=n
    if(item.tasaIVA===10) totG10_80+=n
  }

  const totalGen80=totEx80+totG5_80+totG10_80||Number(doc.montoTotal)||0
  const iva5_80   =Number(doc.montoIva5) ||0
  const iva10_80  =Number(doc.montoIva10)||0

  ln(y); y-=5
  const fila80=(label,valor,bold=false)=>{
    const f=bold?fBold:fReg, sz=bold?8.5:7.5
    t(label,MG,y-7,{font:f,size:sz})
    tR(String(valor),PW-MG,y-7,{font:f,size:sz})
    y-=bold?12:10
  }
  if(totEx80  >0) fila80('Exentas:',    formatNum(totEx80,  moneda))
  if(totG5_80 >0){fila80('Gravadas 5%:',formatNum(totG5_80, moneda));fila80('IVA 5%:', formatNum(iva5_80, moneda))}
  if(totG10_80>0){fila80('Gravadas 10%:',formatNum(totG10_80,moneda));fila80('IVA 10%:',formatNum(iva10_80,moneda))}
  ln(y); y-=3
  fila80(`TOTAL ${moneda}:`,formatNum(totalGen80,moneda),true)
  ln(y); y-=10

  try {
    const qrImg80=await embedQR(pdfDoc,qrBase64)
    if(qrImg80){
      const qrSz=PW-MG*2
      page.drawImage(qrImg80,{x:MG,y:y-qrSz,width:qrSz,height:qrSz})
      y-=qrSz+5
      tC('Verificar en ekuatia.set.gov.py',y-7,{size:6,color:C_GRIS}); y-=10
    }
  } catch(e){/* sin QR */}

  ln(y); y-=5
  tC('CDC:',y-7,{font:fBold,size:6.5}); y-=9
  const cdc80=doc.cdc||''
  tC(cdc80.substring(0,15), y-6,{size:6}); y-=8
  tC(cdc80.substring(15,30),y-6,{size:6}); y-=8
  tC(cdc80.substring(30),   y-6,{size:6}); y-=10
  ln(y); y-=6
  tC('NODO - Facturacion Electronica Paraguay',y-6,{size:6,color:C_GRIS})

  return pdfDoc.save()
}

// ── Funcion unificada ─────────────────────────────────────────────────────────
export async function generarKude(doc, tenant, formato = 'a4', qrBase64 = null) {
  if (formato === 'ticket58')                         return generarKudeTicket58(doc, tenant, qrBase64)
  if (formato === 'ticket' || formato === 'ticket80') return generarKudeTicket(doc, tenant, qrBase64)
  return generarKudeA4(doc, tenant, qrBase64)
}
