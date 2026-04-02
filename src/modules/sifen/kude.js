// src/modules/sifen/kude.js
// Generador de KUDE (Komprobante Unico de Documento Electronico)
// Layout basado en el estandar SIFEN SET Paraguay
// Formato A4, Ticket 80mm y Ticket 58mm usando pdf-lib

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// ── Colores ───────────────────────────────────────────────────────────────────
const COLOR_NEGRO      = rgb(0.10, 0.10, 0.10)
const COLOR_GRIS       = rgb(0.45, 0.45, 0.45)
const COLOR_GRIS_CLARO = rgb(0.93, 0.93, 0.93)
const COLOR_BLANCO     = rgb(1, 1, 1)
const COLOR_BORDE      = rgb(0.70, 0.70, 0.70)
const COLOR_VERDE      = rgb(0.13, 0.55, 0.13)
const COLOR_ROJO       = rgb(0.75, 0.15, 0.15)
const COLOR_HEADER     = rgb(0.20, 0.20, 0.20)

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

// ── Formatters ────────────────────────────────────────────────────────────────
function formatMoneda(valor, moneda = 'PYG') {
  if (!valor && valor !== 0) return '0'
  const n = Number(valor)
  if (moneda === 'PYG') {
    return n.toLocaleString('es-PY', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  }
  return n.toLocaleString('es-PY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatFecha(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}

function formatHora(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}

function formatCDC(cdc) {
  if (!cdc) return ''
  return cdc.replace(/(.{4})/g, '$1 ').trim()
}

function truncar(texto, max) {
  if (!texto) return ''
  const t = String(texto)
  return t.length > max ? t.substring(0, max - 1) + '.' : t
}

// ── KUDE A4 ───────────────────────────────────────────────────────────────────
export async function generarKudeA4(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595, 842])
  const { width, height } = page.getSize()

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const M = 28
  let y = height - M

  const txt = (text, x, yPos, opts = {}) => {
    const { font = fontRegular, size = 7.5, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    page.drawText(s, { x, y: yPos, size, font, color })
  }

  const txtR = (text, xRight, yPos, opts = {}) => {
    const { font = fontRegular, size = 7.5, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: xRight - w, y: yPos, size, font, color })
  }

  const txtC = (text, x1, x2, yPos, opts = {}) => {
    const { font = fontRegular, size = 7.5, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: x1 + (x2 - x1 - w) / 2, y: yPos, size, font, color })
  }

  const lin = (x1, y1, x2, y2, thickness = 0.5, color = COLOR_BORDE) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color })
  }

  const box = (x, yPos, w, h, opts = {}) => {
    const o = { x, y: yPos, width: w, height: h, borderWidth: opts.borderWidth ?? 0.5, opacity: opts.opacity ?? 1 }
    if (opts.fill)   o.color       = opts.fill
    if (opts.border) o.borderColor = opts.border
    page.drawRectangle(o)
  }

  const payload  = doc.payloadJson || {}
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const tipoDoc  = doc.tipoDocumento || 1
  const moneda   = payload.moneda || 'PYG'
  const W        = width - M * 2

  // ── CABECERA ─────────────────────────────────────────────────────────────────
  const headerH = 72
  box(M, y - headerH, W, headerH, { border: COLOR_BORDE })
  const divX = M + W * 0.55
  lin(divX, y, divX, y - headerH)

  // Lado izquierdo - datos emisor
  txt(truncar(tenant.razonSocial || 'EMPRESA', 40), M + 6, y - 12, { font: fontBold, size: 9 })
  txt(`RUC: ${tenant.ruc || ''}`, M + 6, y - 24, { font: fontBold, size: 8 })
  txt(truncar(tenant.direccion || '', 50), M + 6, y - 34, { size: 7 })
  if (tenant.telefono) txt(`Tel: ${tenant.telefono}`, M + 6, y - 43, { size: 7 })
  if (tenant.email)    txt(truncar(tenant.email, 45), M + 6, y - 52, { size: 7 })
  const actEco = Array.isArray(tenant.actividadesEconomicas)
    ? tenant.actividadesEconomicas[0]?.descripcion || ''
    : ''
  if (actEco) txt(truncar(actEco, 50) + '.', M + 6, y - 62, { size: 6.5, color: COLOR_GRIS })

  // Lado derecho - timbrado y numero
  txt('Timbrado', divX + 6, y - 10, { font: fontBold, size: 7.5 })
  txtR(doc.timbradoNumero || '', M + W - 4, y - 10, { font: fontBold, size: 8 })
  txt('Fecha Inicio de Vigencia:', divX + 6, y - 22, { size: 7 })
  txtR(formatFecha(doc.timbradoVigenciaDesde || ''), M + W - 4, y - 22, { size: 7 })
  const tipoLabel = TIPOS_DOC[tipoDoc] || 'DOCUMENTO ELECTRONICO'
  txtC(tipoLabel, divX, M + W, y - 36, { font: fontBold, size: 8.5 })
  txtC(`N  ${doc.numero || ''}`, divX, M + W, y - 49, { font: fontBold, size: 9 })

  y -= headerH

  // ── RECEPTOR ─────────────────────────────────────────────────────────────────
  const recH = 58
  box(M, y - recH, W, recH, { border: COLOR_BORDE })
  const recColW = W * 0.60
  const recDivX = M + recColW
  lin(recDivX, y, recDivX, y - recH)

  txt('Fecha y hora de emision:', M + 4, y - 9, { font: fontBold, size: 7 })
  txt(`${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, M + 4, y - 18, { size: 7.5 })
  txt('Condicion Venta:', M + 4, y - 28, { font: fontBold, size: 7 })
  txt('Contado', M + 4, y - 37, { size: 7.5 })
  txt('Tipo de Transaccion:', M + 4, y - 47, { font: fontBold, size: 7 })
  txt('Venta de mercaderia', M + 4, y - recH + 6, { size: 6.5, color: COLOR_GRIS })

  const rrx = recDivX + 6
  const tipoDocRec = receptor.tipo === 1 ? 'RUC' : receptor.tipo === 2 ? 'C.I.' : receptor.tipo === 3 ? 'C.I.' : 'N/A'
  txt(`${tipoDocRec}:`, rrx, y - 9, { font: fontBold, size: 7 })
  txt(receptor.documento || '0', rrx + 25, y - 9, { size: 7.5 })
  txt('Razon Social:', rrx, y - 20, { font: fontBold, size: 7 })
  txt(truncar(receptor.razonSocial || 'CONSUMIDOR FINAL', 35), rrx, y - 29, { size: 7.5 })
  if (receptor.email) {
    txt('Email:', rrx, y - 39, { font: fontBold, size: 7 })
    txt(truncar(receptor.email, 35), rrx, y - 48, { size: 7 })
  }
  txt('Moneda:', M + 4, y - recH + 17, { font: fontBold, size: 7 })
  txt(moneda, M + 4 + 35, y - recH + 17, { size: 7 })

  y -= recH

  // ── TABLA ITEMS ──────────────────────────────────────────────────────────────
  const cols = {
    cod:    { x: M,              w: W * 0.07 },
    desc:   { x: M + W * 0.07,  w: W * 0.32 },
    uni:    { x: M + W * 0.39,  w: W * 0.07 },
    cant:   { x: M + W * 0.46,  w: W * 0.07 },
    precio: { x: M + W * 0.53,  w: W * 0.13 },
    desc2:  { x: M + W * 0.66,  w: W * 0.09 },
    exenta: { x: M + W * 0.75,  w: W * 0.08 },
    iva5:   { x: M + W * 0.83,  w: W * 0.08 },
    iva10:  { x: M + W * 0.91,  w: W * 0.09 },
  }

  const rowH = 13
  const thH  = 16

  box(M, y - thH, W, thH, { fill: COLOR_HEADER })
  const headers = [
    { key: 'cod',    label: 'Cod.' },
    { key: 'desc',   label: 'Descripcion' },
    { key: 'uni',    label: 'U.Med.' },
    { key: 'cant',   label: 'Cant.' },
    { key: 'precio', label: 'Precio Unit.' },
    { key: 'desc2',  label: 'Desc/Antic.' },
    { key: 'exenta', label: 'Exentas' },
    { key: 'iva5',   label: '5%' },
    { key: 'iva10',  label: '10%' },
  ]
  for (const h of headers) {
    const col = cols[h.key]
    txtC(h.label, col.x, col.x + col.w, y - 5, { font: fontBold, size: 6.5, color: COLOR_BLANCO })
  }
  for (const k of Object.keys(cols)) lin(cols[k].x, y, cols[k].x, y - thH, 0.3, COLOR_BORDE)
  lin(M + W, y, M + W, y - thH, 0.3, COLOR_BORDE)
  y -= thH

  for (let i = 0; i < items.length; i++) {
    const item  = items[i]
    if (i % 2 === 1) box(M, y - rowH, W, rowH, { fill: COLOR_GRIS_CLARO })
    const exenta = item.tasaIVA === 0  ? item.precioTotal : 0
    const grav5  = item.tasaIVA === 5  ? item.precioTotal : 0
    const grav10 = item.tasaIVA === 10 ? item.precioTotal : 0
    txt(String(i + 1).padStart(3, '0'), cols.cod.x + 2, y - 9, { size: 7 })
    txt(truncar(item.descripcion || '', 40), cols.desc.x + 2, y - 9, { size: 7 })
    txtC('UNI', cols.uni.x, cols.uni.x + cols.uni.w, y - 9, { size: 7 })
    txtR(String(item.cantidad), cols.cant.x + cols.cant.w - 2, y - 9, { size: 7 })
    txtR(formatMoneda(item.precioUnitario, moneda), cols.precio.x + cols.precio.w - 2, y - 9, { size: 7 })
    txtR('0', cols.desc2.x + cols.desc2.w - 2, y - 9, { size: 7 })
    txtR(exenta > 0 ? formatMoneda(exenta, moneda) : '0', cols.exenta.x + cols.exenta.w - 2, y - 9, { size: 7 })
    txtR(grav5  > 0 ? formatMoneda(grav5,  moneda) : '0', cols.iva5.x   + cols.iva5.w   - 2, y - 9, { size: 7 })
    txtR(grav10 > 0 ? formatMoneda(grav10, moneda) : '0', cols.iva10.x  + cols.iva10.w  - 2, y - 9, { size: 7 })
    for (const k of Object.keys(cols)) lin(cols[k].x, y, cols[k].x, y - rowH, 0.3, COLOR_BORDE)
    lin(M + W, y, M + W, y - rowH, 0.3, COLOR_BORDE)
    lin(M, y - rowH, M + W, y - rowH, 0.3, COLOR_BORDE)
    y -= rowH
  }

  const minRows = 5
  for (let i = 0; i < Math.max(0, minRows - items.length); i++) {
    for (const k of Object.keys(cols)) lin(cols[k].x, y, cols[k].x, y - rowH, 0.3, COLOR_BORDE)
    lin(M + W, y, M + W, y - rowH, 0.3, COLOR_BORDE)
    lin(M, y - rowH, M + W, y - rowH, 0.3, COLOR_BORDE)
    y -= rowH
  }

  // ── SUBTOTALES ───────────────────────────────────────────────────────────────
  const stH  = 14
  const stCols = {
    exenta: { x: M + W * 0.75, w: W * 0.08 },
    iva5:   { x: M + W * 0.83, w: W * 0.08 },
    iva10:  { x: M + W * 0.91, w: W * 0.09 },
  }

  box(M, y - stH, W, stH, { fill: COLOR_GRIS_CLARO, border: COLOR_BORDE })
  txt('SUBTOTALES:', M + 4, y - 9, { font: fontBold, size: 7 })
  for (const [k, col] of Object.entries(stCols)) lin(col.x, y, col.x, y - stH, 0.3, COLOR_BORDE)
  lin(M + W, y, M + W, y - stH, 0.3, COLOR_BORDE)
  txtR(formatMoneda(doc.montoExento || 0, moneda), stCols.exenta.x + stCols.exenta.w - 2, y - 9, { size: 7 })
  txtR(formatMoneda(Math.round((doc.montoIva5  || 0) * 21), moneda), stCols.iva5.x  + stCols.iva5.w  - 2, y - 9, { size: 7 })
  txtR(formatMoneda(Math.round((doc.montoIva10 || 0) * 11), moneda), stCols.iva10.x + stCols.iva10.w - 2, y - 9, { size: 7 })
  y -= stH

  box(M, y - stH, W, stH, { border: COLOR_BORDE })
  txt('SUMA TOTAL:', M + 4, y - 9, { font: fontBold, size: 7 })
  txtR(formatMoneda(doc.montoTotal || 0, moneda), M + W - 4, y - 9, { font: fontBold, size: 8 })
  y -= stH

  box(M, y - stH, W, stH, { border: COLOR_BORDE })
  txt('DESCUENTO/ANTICIPO GLOBAL:', M + 4, y - 9, { size: 7 })
  txtR('0', M + W - 4, y - 9, { size: 7 })
  y -= stH

  box(M, y - stH, W, stH, { fill: COLOR_HEADER, border: COLOR_BORDE })
  txt('TOTAL DE LA OPERACION:', M + 4, y - 9, { font: fontBold, size: 8, color: COLOR_BLANCO })
  txtR(formatMoneda(doc.montoTotal || 0, moneda), M + W - 4, y - 9, { font: fontBold, size: 9, color: COLOR_BLANCO })
  y -= stH

  // ── LIQUIDACION IVA ──────────────────────────────────────────────────────────
  const ivaH   = 16
  const ivaColW = W / 3
  box(M, y - ivaH, W, ivaH, { border: COLOR_BORDE })
  txt('LIQUIDACION IVA:', M + 4, y - 6, { font: fontBold, size: 7 })
  txt(`(5%)  ${formatMoneda(doc.montoIva5 || 0, moneda)}`, M + 4, y - 13, { size: 7 })
  txt(`(10%)  ${formatMoneda(doc.montoIva10 || 0, moneda)}`, M + ivaColW, y - 13, { size: 7 })
  txt(`Total IVA:  ${formatMoneda((doc.montoIva5 || 0) + (doc.montoIva10 || 0), moneda)}`, M + ivaColW * 2, y - 13, { font: fontBold, size: 7 })
  y -= ivaH

  // ── QR + CDC ─────────────────────────────────────────────────────────────────
  y -= 8
  const qrSize = 80

  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      page.drawImage(qrImage, { x: M, y: y - qrSize, width: qrSize, height: qrSize })
    } catch (e) { /* sin QR */ }
  }

  const cdcX = M + qrSize + 10
  txt('Consulte la validez de este Documento Electronico con el numero de CDC impreso', cdcX, y - 8, { size: 6.5, color: COLOR_GRIS })
  txt('https://ekuatia.set.gov.py/consultas', cdcX, y - 17, { size: 6.5, color: COLOR_GRIS })
  txt('CDC:', cdcX, y - 30, { font: fontBold, size: 7 })
  const cdcFormato = formatCDC(doc.cdc || '')
  const mitad = Math.ceil(cdcFormato.length / 2)
  txt(cdcFormato.substring(0, mitad), cdcX, y - 40, { font: fontBold, size: 8 })
  txt(cdcFormato.substring(mitad).trim(), cdcX, y - 50, { font: fontBold, size: 8 })

  const estadoColor = doc.estado === 'aprobado' ? COLOR_VERDE : COLOR_ROJO
  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO POR LA SET' : (doc.estado || '').toUpperCase()
  txt(estadoTxt, cdcX, y - 63, { font: fontBold, size: 8, color: estadoColor })
  if (doc.estado === 'aprobado') {
    txt(`Fecha: ${formatFecha(doc.sifenRespEn)} ${formatHora(doc.sifenRespEn)}`, cdcX, y - 73, { size: 7, color: COLOR_GRIS })
  }

  y -= qrSize + 10
  lin(M, y, M + W, y, 0.5, COLOR_BORDE)
  y -= 10
  txt('Si su documento electronico presenta algun error puede solicitar la modificacion dentro de las 72 horas siguientes de la emision de este comprobante.', M, y, { size: 6, color: COLOR_GRIS })
  y -= 10
  txt('ESTE DOCUMENTO ES UNA REPRESENTACION GRAFICA DE UN DOCUMENTO ELECTRONICO (XML)', M, y, { font: fontBold, size: 6.5 })
  y -= 10
  txt('Generado por NODO - Plataforma de Facturacion Electronica Paraguay | nodo.com.py', M, y, { size: 6, color: COLOR_GRIS })

  return pdfDoc.save()
}

// ── KUDE Ticket 80mm ──────────────────────────────────────────────────────────
export async function generarKudeTicket(doc, tenant, qrBase64 = null) {
  const pdfDoc  = await PDFDocument.create()
  const mmToPt  = mm => mm * 2.8346
  const pageW   = mmToPt(80)
  const payload = doc.payloadJson || {}
  const items   = payload.items || []
  const receptor = payload.receptor || {}
  const moneda  = payload.moneda || 'PYG'
  const tipoDoc = doc.tipoDocumento || 1
  const baseH   = 380
  const itemsH  = items.length * 22
  const qrH     = qrBase64 ? mmToPt(55) + 20 : 0
  const pageH   = baseH + itemsH + qrH
  const page    = pdfDoc.addPage([pageW, pageH])

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const margin = 6
  let y = pageH - margin

  const txt = (text, x, yPos, opts = {}) => {
    const { font = fontRegular, size = 7, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    page.drawText(s, { x, y: yPos, size, font, color })
  }
  const txtC = (text, yPos, opts = {}) => {
    const { font = fontRegular, size = 7, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: Math.max(margin, (pageW - w) / 2), y: yPos, size, font, color })
  }
  const lin = (y1) => page.drawLine({ start: { x: margin, y: y1 }, end: { x: pageW - margin, y: y1 }, thickness: 0.4, color: COLOR_BORDE })
  const maxW = pageW - margin * 2
  const truncA = (text, font, size) => {
    let s = String(text ?? '')
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1)
    return s
  }

  txtC(truncA(tenant.razonSocial || 'EMPRESA', fontBold, 8), y - 10, { font: fontBold, size: 8 })
  y -= 13
  txtC(`RUC: ${tenant.ruc || ''}`, y - 7, { size: 7 })
  y -= 10
  txtC(truncA(tenant.direccion || '', fontRegular, 6.5), y - 7, { size: 6.5, color: COLOR_GRIS })
  y -= 10
  txtC(TIPOS_DOC[tipoDoc] || 'DOC. ELECTRONICO', y - 7, { font: fontBold, size: 7.5 })
  y -= 11
  txtC(`N  ${doc.numero || ''}`, y - 7, { font: fontBold, size: 8 })
  y -= 11
  txtC(`Timbrado: ${doc.timbradoNumero || ''}`, y - 7, { size: 6 })
  y -= 9
  txtC(`${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, y - 7, { size: 6.5 })
  y -= 11
  lin(y); y -= 6

  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO SET' : (doc.estado || '').toUpperCase()
  const estadoColor = doc.estado === 'aprobado' ? COLOR_VERDE : COLOR_ROJO
  txtC(estadoTxt, y - 7, { font: fontBold, size: 7.5, color: estadoColor })
  y -= 11
  lin(y); y -= 6

  if (receptor.razonSocial) { txt(truncA(`Cliente: ${receptor.razonSocial}`, fontRegular, 6.5), margin, y - 7, { size: 6.5 }); y -= 10 }
  if (receptor.documento) { txt(`${receptor.tipo === 1 ? 'RUC' : 'C.I.'}: ${receptor.documento}`, margin, y - 7, { size: 6.5 }); y -= 10 }
  lin(y); y -= 5

  txt('Descripcion', margin, y - 7, { font: fontBold, size: 6.5 })
  const thW = fontBold.widthOfTextAtSize('Total', 6.5)
  txt('Total', pageW - margin - thW, y - 7, { font: fontBold, size: 6.5 })
  y -= 9; lin(y); y -= 4

  for (const item of items) {
    const totalStr = formatMoneda(item.precioTotal, moneda)
    const totalW   = fontRegular.widthOfTextAtSize(totalStr, 7)
    let desc = String(item.descripcion || '')
    while (desc.length > 0 && fontRegular.widthOfTextAtSize(desc, 6.5) > maxW - totalW - 4) desc = desc.slice(0, -1)
    txt(desc, margin, y - 7, { size: 6.5 })
    txt(totalStr, pageW - margin - totalW, y - 7, { size: 7 })
    y -= 10
    const det = `${item.cantidad} x ${formatMoneda(item.precioUnitario, moneda)} | IVA ${item.tasaIVA}%`
    let detTxt = det
    while (detTxt.length > 0 && fontRegular.widthOfTextAtSize(detTxt, 6) > maxW) detTxt = detTxt.slice(0, -1)
    txt(detTxt, margin, y - 7, { size: 6, color: COLOR_GRIS })
    y -= 10
  }

  lin(y); y -= 5
  const fila = (label, valor, bold = false) => {
    const f = bold ? fontBold : fontRegular
    const sz = bold ? 8 : 7
    txt(label, margin, y - 7, { font: f, size: sz })
    const v = String(valor)
    txt(v, pageW - margin - f.widthOfTextAtSize(v, sz), y - 7, { font: f, size: sz })
    y -= bold ? 11 : 10
  }
  if ((doc.montoExento || 0) > 0) fila('Exentas:', formatMoneda(doc.montoExento, moneda))
  if ((doc.montoIva5   || 0) > 0) { fila('Grav. 5%:', formatMoneda(Math.round(doc.montoIva5 * 21), moneda)); fila('IVA 5%:', formatMoneda(doc.montoIva5, moneda)) }
  if ((doc.montoIva10  || 0) > 0) { fila('Grav. 10%:', formatMoneda(Math.round(doc.montoIva10 * 11), moneda)); fila('IVA 10%:', formatMoneda(doc.montoIva10, moneda)) }
  lin(y); y -= 4
  fila(`TOTAL ${moneda}:`, formatMoneda(doc.montoTotal, moneda), true)
  lin(y); y -= 8

  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2
      page.drawImage(qrImage, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 4
      txtC('Verificar en ekuatia.set.gov.py', y - 7, { size: 5.5, color: COLOR_GRIS })
      y -= 10
    } catch (e) { /* sin QR */ }
  }

  lin(y); y -= 5
  txtC('CDC:', y - 6, { font: fontBold, size: 5.5 }); y -= 9
  const cdc = doc.cdc || ''
  txtC(cdc.substring(0, 15),  y - 6, { size: 5 }); y -= 7
  txtC(cdc.substring(15, 30), y - 6, { size: 5 }); y -= 7
  txtC(cdc.substring(30),     y - 6, { size: 5 }); y -= 10
  lin(y); y -= 6
  txtC('NODO - Facturacion Electronica Paraguay', y - 6, { size: 5.5, color: COLOR_GRIS })

  return pdfDoc.save()
}

// ── KUDE Ticket 58mm ──────────────────────────────────────────────────────────
export async function generarKudeTicket58(doc, tenant, qrBase64 = null) {
  const pdfDoc  = await PDFDocument.create()
  const mmToPt  = mm => mm * 2.8346
  const pageW   = mmToPt(58)
  const payload = doc.payloadJson || {}
  const items   = payload.items || []
  const receptor = payload.receptor || {}
  const moneda  = payload.moneda || 'PYG'
  const tipoDoc = doc.tipoDocumento || 1
  const baseH   = 300
  const itemsH  = items.length * 20
  const qrH     = qrBase64 ? mmToPt(48) + 20 : 0
  const pageH   = baseH + itemsH + qrH
  const page    = pdfDoc.addPage([pageW, pageH])

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const margin = 4
  let y = pageH - margin

  const txt = (text, x, yPos, opts = {}) => {
    const { font = fontRegular, size = 6.5, color = COLOR_NEGRO } = opts
    page.drawText(String(text ?? ''), { x, y: yPos, size, font, color })
  }
  const txtC = (text, yPos, opts = {}) => {
    const { font = fontRegular, size = 6.5, color = COLOR_NEGRO } = opts
    const s = String(text ?? '')
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: Math.max(margin, (pageW - w) / 2), y: yPos, size, font, color })
  }
  const lin = (y1) => page.drawLine({ start: { x: margin, y: y1 }, end: { x: pageW - margin, y: y1 }, thickness: 0.4, color: COLOR_BORDE })
  const maxW = pageW - margin * 2
  const truncA = (text, font, size) => {
    let s = String(text ?? '')
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1)
    return s
  }

  txtC(truncA(tenant.razonSocial || 'EMPRESA', fontBold, 8), y - 10, { font: fontBold, size: 8 }); y -= 13
  txtC(`RUC: ${tenant.ruc || ''}`, y - 7, { size: 6 }); y -= 9
  txtC(TIPOS_DOC[tipoDoc] || 'DOC. ELECTRONICO', y - 7, { font: fontBold, size: 7 }); y -= 10
  txtC(`N  ${doc.numero || ''}`, y - 7, { font: fontBold, size: 7.5 }); y -= 10
  txtC(`${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, y - 7, { size: 6 }); y -= 10
  lin(y); y -= 5

  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO SET' : (doc.estado || '').toUpperCase()
  const estadoColor = doc.estado === 'aprobado' ? COLOR_VERDE : COLOR_ROJO
  txtC(estadoTxt, y - 7, { font: fontBold, size: 7, color: estadoColor }); y -= 10
  lin(y); y -= 5

  if (receptor.razonSocial) { txt(truncA(`Cliente: ${receptor.razonSocial}`, fontRegular, 6), margin, y - 7, { size: 6 }); y -= 9 }
  lin(y); y -= 5

  txt('Descripcion', margin, y - 7, { font: fontBold, size: 6 })
  txt('Total', pageW - margin - fontBold.widthOfTextAtSize('Total', 6), y - 7, { font: fontBold, size: 6 })
  y -= 8; lin(y); y -= 4

  for (const item of items) {
    const totalStr = formatMoneda(item.precioTotal, moneda)
    const totalW   = fontRegular.widthOfTextAtSize(totalStr, 6.5)
    let desc = String(item.descripcion || '')
    while (desc.length > 0 && fontRegular.widthOfTextAtSize(desc, 6) > maxW - totalW - 4) desc = desc.slice(0, -1)
    txt(desc, margin, y - 7, { size: 6 })
    txt(totalStr, pageW - margin - totalW, y - 7, { size: 6.5 })
    y -= 9
    const det = `${item.cantidad} x ${formatMoneda(item.precioUnitario, moneda)} | IVA ${item.tasaIVA}%`
    let detTxt = det
    while (detTxt.length > 0 && fontRegular.widthOfTextAtSize(detTxt, 5.5) > maxW) detTxt = detTxt.slice(0, -1)
    txt(detTxt, margin, y - 7, { size: 5.5, color: COLOR_GRIS })
    y -= 9
  }

  lin(y); y -= 5
  const fila = (label, valor, bold = false) => {
    const f = bold ? fontBold : fontRegular
    const sz = bold ? 7.5 : 6.5
    txt(label, margin, y - 7, { font: f, size: sz })
    const v = String(valor)
    txt(v, pageW - margin - f.widthOfTextAtSize(v, sz), y - 7, { font: f, size: sz })
    y -= bold ? 10 : 9
  }
  if ((doc.montoIva5  || 0) > 0) fila('IVA 5%:',  formatMoneda(doc.montoIva5,  moneda))
  if ((doc.montoIva10 || 0) > 0) fila('IVA 10%:', formatMoneda(doc.montoIva10, moneda))
  lin(y); y -= 3
  fila(`TOTAL ${moneda}:`, formatMoneda(doc.montoTotal, moneda), true)
  lin(y); y -= 8

  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2
      page.drawImage(qrImage, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 4
    } catch (e) { /* sin QR */ }
  }

  lin(y); y -= 4
  const cdc = doc.cdc || ''
  txtC(cdc.substring(0, 15),  y - 6, { size: 4.8 }); y -= 7
  txtC(cdc.substring(15, 30), y - 6, { size: 4.8 }); y -= 7
  txtC(cdc.substring(30),     y - 6, { size: 4.8 }); y -= 9
  lin(y); y -= 5
  txtC('NODO - Facturacion Electronica', y - 6, { size: 5, color: COLOR_GRIS })

  return pdfDoc.save()
}

// ── Funcion unificada ─────────────────────────────────────────────────────────
export async function generarKude(doc, tenant, formato = 'a4', qrBase64 = null) {
  if (formato === 'ticket58')                    return generarKudeTicket58(doc, tenant, qrBase64)
  if (formato === 'ticket' || formato === 'ticket80') return generarKudeTicket(doc, tenant, qrBase64)
  return generarKudeA4(doc, tenant, qrBase64)
}
