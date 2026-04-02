// src/modules/sifen/kude.js
// Generador de KUDE (Komprobante Único de Documento Electrónico)
// Genera PDF en formato A4, Ticket 80mm y Ticket 58mm usando pdf-lib
// Sin dependencias de Java ni JasperReports

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// ── Colores NODO ──────────────────────────────────────────────────────────────
const COLOR_PRIMARIO   = rgb(0.89, 0.49, 0.07)  // Naranja NODO #E37D12
const COLOR_OSCURO     = rgb(0.15, 0.15, 0.15)  // Casi negro
const COLOR_GRIS       = rgb(0.45, 0.45, 0.45)  // Gris texto secundario
const COLOR_GRIS_CLARO = rgb(0.92, 0.92, 0.92)  // Fondo filas alternas
const COLOR_BLANCO     = rgb(1, 1, 1)
const COLOR_BORDE      = rgb(0.80, 0.80, 0.80)

// ── Tipos de documento ────────────────────────────────────────────────────────
const TIPOS_DOC = {
  1: 'FACTURA ELECTRÓNICA',
  2: 'FACTURA ELECTRÓNICA DE EXPORTACIÓN',
  3: 'FACTURA ELECTRÓNICA DE IMPORTACIÓN',
  4: 'AUTOFACTURA ELECTRÓNICA',
  5: 'NOTA DE CRÉDITO ELECTRÓNICA',
  6: 'NOTA DE DÉBITO ELECTRÓNICA',
  7: 'NOTA DE REMISIÓN ELECTRÓNICA',
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
  return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatHora(fecha) {
  if (!fecha) return ''
  const d = new Date(fecha)
  return d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' })
}

function truncar(texto, max) {
  if (!texto) return ''
  const t = String(texto)
  return t.length > max ? t.substring(0, max - 1) + '.' : t
}

// ── Función principal: genera KUDE A4 ─────────────────────────────────────────
export async function generarKudeA4(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595, 842]) // A4 en puntos
  const { width, height } = page.getSize()

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const margin = 30
  let y = height - margin

  // ── Helper de texto ──────────────────────────────────────────────────────────
  const texto = (text, x, yPos, opts = {}) => {
    const {
      font = fontRegular,
      size = 8,
      color = COLOR_OSCURO,
      maxWidth = null,
    } = opts
    const t = String(text ?? '')
    const finalText = maxWidth
      ? truncarPDF(t, font, size, maxWidth)
      : t
    page.drawText(finalText, { x, y: yPos, size, font, color })
  }

  const truncarPDF = (t, font, size, maxWidth) => {
    let s = t
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxWidth) {
      s = s.slice(0, -1)
    }
    return s.length < t.length ? s + '.' : s
  }

  const linea = (x1, y1, x2, y2, opts = {}) => {
    page.drawLine({
      start: { x: x1, y: y1 },
      end:   { x: x2, y: y2 },
      thickness: opts.thickness || 0.5,
      color: opts.color || COLOR_BORDE,
    })
  }

  const rect = (x, yPos, w, h, opts = {}) => {
    const rectOpts = {
      x, y: yPos, width: w, height: h,
      borderWidth: opts.borderWidth || 0.5,
      opacity: opts.opacity || 1,
    }
    if (opts.fill)   rectOpts.color       = opts.fill
    if (opts.border) rectOpts.borderColor = opts.border
    page.drawRectangle(rectOpts)
  }

  const payload  = doc.payloadJson || {}
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const tipoDoc  = doc.tipoDocumento || 1
  const moneda   = payload.moneda || 'PYG'

  // ══════════════════════════════════════════════════════════════════════════
  // CABECERA
  // ══════════════════════════════════════════════════════════════════════════

  // Barra naranja superior
  rect(margin, y - 55, width - margin * 2, 55, { fill: COLOR_PRIMARIO })

  // Nombre empresa (blanco sobre naranja)
  texto(truncar(tenant.razonSocial || 'EMPRESA', 35), margin + 10, y - 22, {
    font: fontBold, size: 14, color: COLOR_BLANCO,
  })
  texto(`RUC: ${tenant.ruc || ''}`, margin + 10, y - 36, {
    font: fontRegular, size: 9, color: COLOR_BLANCO,
  })
  texto(truncar(tenant.direccion || '', 55), margin + 10, y - 47, {
    font: fontRegular, size: 8, color: COLOR_BLANCO,
  })

  // Tipo de documento (derecha)
  const tipoLabel = TIPOS_DOC[tipoDoc] || 'DOCUMENTO ELECTRÓNICO'
  const tipoW = fontBold.widthOfTextAtSize(tipoLabel, 10)
  texto(tipoLabel, width - margin - tipoW - 10, y - 20, {
    font: fontBold, size: 10, color: COLOR_BLANCO,
  })
  texto(`N° ${doc.numero || ''}`, width - margin - 120, y - 33, {
    font: fontBold, size: 9, color: COLOR_BLANCO,
  })
  texto(`Timbrado: ${doc.timbradoId || ''}`, width - margin - 120, y - 44, {
    font: fontRegular, size: 8, color: COLOR_BLANCO,
  })

  y -= 60

  // ── Franja de estado ────────────────────────────────────────────────────────
  const estadoColor = doc.estado === 'aprobado' ? rgb(0.13, 0.55, 0.13) : rgb(0.75, 0.15, 0.15)
  rect(margin, y - 14, width - margin * 2, 14, { fill: estadoColor })
  const estadoLabel = doc.estado === 'aprobado'
    ? `APROBADO POR LA SET — Fecha: ${formatFecha(doc.sifenRespEn)} ${formatHora(doc.sifenRespEn)}`
    : `DOCUMENTO ${(doc.estado || '').toUpperCase()}`
  texto(estadoLabel, margin + 6, y - 10, {
    font: fontBold, size: 7.5, color: COLOR_BLANCO,
  })
  y -= 18

  // ── CDC ─────────────────────────────────────────────────────────────────────
  rect(margin, y - 14, width - margin * 2, 14, { fill: rgb(0.96, 0.96, 0.96), borderWidth: 0 })
  texto('CDC:', margin + 6, y - 10, { font: fontBold, size: 7 })
  texto(doc.cdc || '', margin + 26, y - 10, { font: fontRegular, size: 7 })
  y -= 18

  // ══════════════════════════════════════════════════════════════════════════
  // DATOS DEL DOCUMENTO
  // ══════════════════════════════════════════════════════════════════════════
  y -= 5

  const colW = (width - margin * 2) / 2 - 4

  // Bloque Emisor
  rect(margin, y - 70, colW, 70, { border: COLOR_BORDE })
  texto('DATOS DEL EMISOR', margin + 5, y - 10, { font: fontBold, size: 7.5, color: COLOR_PRIMARIO })
  linea(margin, y - 12, margin + colW, y - 12)
  texto('Razón Social:', margin + 5, y - 22, { font: fontBold, size: 7 })
  texto(truncar(tenant.razonSocial || '', 40), margin + 5, y - 31, { size: 7.5 })
  texto('RUC:', margin + 5, y - 42, { font: fontBold, size: 7 })
  texto(tenant.ruc || '', margin + 22, y - 42, { size: 7.5 })
  texto('Dirección:', margin + 5, y - 53, { font: fontBold, size: 7 })
  texto(truncar(tenant.direccion || 'Paraguay', 40), margin + 5, y - 62, { size: 7 })

  // Bloque Receptor
  const rx = margin + colW + 8
  rect(rx, y - 70, colW, 70, { border: COLOR_BORDE })
  texto('DATOS DEL RECEPTOR', rx + 5, y - 10, { font: fontBold, size: 7.5, color: COLOR_PRIMARIO })
  linea(rx, y - 12, rx + colW, y - 12)
  texto('Razón Social:', rx + 5, y - 22, { font: fontBold, size: 7 })
  texto(truncar(receptor.razonSocial || 'CONSUMIDOR FINAL', 40), rx + 5, y - 31, { size: 7.5 })
  const tipoDocRec = receptor.tipo === 1 ? 'RUC' : receptor.tipo === 2 ? 'C.I.' : receptor.tipo === 3 ? 'Pasaporte' : ''
  if (tipoDocRec) {
    texto(`${tipoDocRec}:`, rx + 5, y - 42, { font: fontBold, size: 7 })
    texto(receptor.documento || '', rx + 32, y - 42, { size: 7.5 })
  }
  if (receptor.email) {
    texto('Email:', rx + 5, y - 53, { font: fontBold, size: 7 })
    texto(truncar(receptor.email, 38), rx + 28, y - 53, { size: 7 })
  }
  texto('Fecha emisión:', rx + 5, y - 63, { font: fontBold, size: 7 })
  texto(`${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, rx + 52, y - 63, { size: 7 })

  y -= 75

  // ══════════════════════════════════════════════════════════════════════════
  // TABLA DE ITEMS
  // ══════════════════════════════════════════════════════════════════════════
  y -= 5
  const tableW = width - margin * 2
  const cols = {
    desc:    { x: margin,           w: tableW * 0.40 },
    cant:    { x: margin + tableW * 0.40, w: tableW * 0.08 },
    precio:  { x: margin + tableW * 0.48, w: tableW * 0.17 },
    iva:     { x: margin + tableW * 0.65, w: tableW * 0.07 },
    total:   { x: margin + tableW * 0.72, w: tableW * 0.28 },
  }

  // Encabezado tabla
  rect(margin, y - 14, tableW, 14, { fill: COLOR_OSCURO })
  texto('Descripción',         cols.desc.x   + 4, y - 10, { font: fontBold, size: 7.5, color: COLOR_BLANCO })
  texto('Cant.',               cols.cant.x   + 2, y - 10, { font: fontBold, size: 7.5, color: COLOR_BLANCO })
  texto('Precio Unit.',        cols.precio.x + 2, y - 10, { font: fontBold, size: 7.5, color: COLOR_BLANCO })
  texto('IVA',                 cols.iva.x    + 2, y - 10, { font: fontBold, size: 7.5, color: COLOR_BLANCO })
  texto('Total',               cols.total.x  + 2, y - 10, { font: fontBold, size: 7.5, color: COLOR_BLANCO })
  y -= 14

  // Filas de items
  let rowIndex = 0
  for (const item of items) {
    const rowH = 13
    if (rowIndex % 2 === 0) {
      rect(margin, y - rowH, tableW, rowH, { fill: COLOR_GRIS_CLARO, borderWidth: 0 })
    }
    const descMaxW = cols.desc.w - 6
    texto(truncarPDF(item.descripcion || '', fontRegular, 7.5, descMaxW), cols.desc.x + 4, y - 9.5, { size: 7.5 })
    texto(String(item.cantidad ?? ''), cols.cant.x + 2, y - 9.5, { size: 7.5 })
    texto(formatMoneda(item.precioUnitario, moneda), cols.precio.x + 2, y - 9.5, { size: 7.5 })
    texto(`${item.tasaIVA ?? 0}%`, cols.iva.x + 2, y - 9.5, { size: 7.5 })
    texto(formatMoneda(item.precioTotal, moneda), cols.total.x + 2, y - 9.5, { size: 7.5 })
    y -= rowH
    rowIndex++
  }

  // Borde exterior tabla
  linea(margin, y, width - margin, y)

  // ══════════════════════════════════════════════════════════════════════════
  // TOTALES
  // ══════════════════════════════════════════════════════════════════════════
  y -= 8
  const totW  = 200
  const totX  = width - margin - totW
  const labX  = totX + 5
  const valX  = width - margin - 5

  const filaTotales = (label, valor, opts = {}) => {
    if (opts.highlight) {
      rect(totX, y - 13, totW, 13, { fill: COLOR_PRIMARIO })
    }
    const colLabel = opts.highlight ? COLOR_BLANCO : COLOR_OSCURO
    const colVal   = opts.highlight ? COLOR_BLANCO : COLOR_OSCURO
    const f        = opts.highlight ? fontBold : fontRegular
    texto(label, labX, y - 10, { font: opts.bold ? fontBold : f, size: 8, color: colLabel })
    const valStr = String(valor)
    const valW   = (opts.highlight ? fontBold : fontRegular).widthOfTextAtSize(valStr, 8)
    texto(valStr, valX - valW, y - 10, { font: opts.bold ? fontBold : f, size: 8, color: colVal })
    linea(totX, y - 13, width - margin, y - 13, { color: COLOR_BORDE })
    y -= 13
  }

  rect(totX, y, totW, 2, { fill: COLOR_PRIMARIO, borderWidth: 0 })
  y -= 2

  if (doc.montoExento > 0)  filaTotales('Exentas:',    formatMoneda(doc.montoExento, moneda))
  if (doc.montoIva5 > 0)    filaTotales('Gravadas 5%:', formatMoneda(doc.montoIva5 * 21, moneda))
  if (doc.montoIva10 > 0)   filaTotales('Gravadas 10%:', formatMoneda(doc.montoIva10 * 11, moneda))
  if (doc.montoIva5 > 0)    filaTotales('IVA 5%:',     formatMoneda(doc.montoIva5, moneda))
  if (doc.montoIva10 > 0)   filaTotales('IVA 10%:',    formatMoneda(doc.montoIva10, moneda))
  filaTotales(`TOTAL ${moneda}:`, formatMoneda(doc.montoTotal, moneda), { highlight: true })

  // ══════════════════════════════════════════════════════════════════════════
  // QR CODE
  // ══════════════════════════════════════════════════════════════════════════
  y -= 10
  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      const qrSize  = 80
      page.drawImage(qrImage, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      texto('Escanear para verificar en portal SET', margin, y - qrSize - 8, {
        font: fontRegular, size: 6.5, color: COLOR_GRIS,
      })
    } catch (e) {
      // QR no disponible, continuar sin él
    }
  }

  // ── Nota KUDE ────────────────────────────────────────────────────────────
  const notaX = qrBase64 ? margin + 95 : margin
  texto('Este documento es una representación impresa de un Documento Electrónico (DE)',
    notaX, y - 10, { size: 6.5, color: COLOR_GRIS })
  texto('emitido conforme a la Resolución General N° 23/2019 de la SET.',
    notaX, y - 19, { size: 6.5, color: COLOR_GRIS })
  if (doc.sifen_codigo) {
    texto(`Código respuesta SET: ${doc.sifen_codigo} — ${doc.sifen_mensaje || ''}`,
      notaX, y - 28, { size: 6.5, color: COLOR_GRIS })
  }

  // ── Footer NODO ───────────────────────────────────────────────────────────
  linea(margin, 18, width - margin, 18, { color: COLOR_PRIMARIO, thickness: 1 })
  texto('Generado por NODO — Plataforma de Facturación Electrónica Paraguay', margin, 10, {
    font: fontRegular, size: 6, color: COLOR_GRIS,
  })
  texto('nodo.com.py', width - margin - 45, 10, {
    font: fontBold, size: 6, color: COLOR_PRIMARIO,
  })

  return pdfDoc.save()
}

// ── Función: genera KUDE Ticket 80mm ─────────────────────────────────────────
export async function generarKudeTicket(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()

  const mmToPt  = mm => mm * 2.8346
  const pageW   = mmToPt(80)

  // Calcular altura dinámica
  const payload  = doc.payloadJson || {}
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const moneda   = payload.moneda || 'PYG'
  const tipoDoc  = doc.tipoDocumento || 1

  const baseH   = 400
  const itemsH  = items.length * 22
  const pageH   = baseH + itemsH
  const page    = pdfDoc.addPage([pageW, pageH])

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const margin = 6
  let y = pageH - margin

  const texto = (text, x, yPos, opts = {}) => {
    const { font = fontRegular, size = 7, color = COLOR_OSCURO } = opts
    page.drawText(String(text ?? ''), { x, y: yPos, size, font, color })
  }

  const linea = (y1) => {
    page.drawLine({
      start: { x: margin, y: y1 },
      end:   { x: pageW - margin, y: y1 },
      thickness: 0.5, color: COLOR_BORDE,
    })
  }

  const centrado = (text, yPos, opts = {}) => {
    const { font = fontRegular, size = 7, color = COLOR_OSCURO } = opts
    const w = font.widthOfTextAtSize(String(text), size)
    const x = (pageW - w) / 2
    page.drawText(String(text), { x, y: yPos, size, font, color })
  }

  // ── Cabecera ────────────────────────────────────────────────────────────────
  centrado(tenant.razonSocial || 'EMPRESA', y - 10, { font: fontBold, size: 9 })
  y -= 12
  centrado(`RUC: ${tenant.ruc || ''}`, y - 8, { size: 7 })
  y -= 10
  centrado(TIPOS_DOC[tipoDoc] || 'DOCUMENTO ELECTRÓNICO', y - 8, { font: fontBold, size: 8 })
  y -= 10
  centrado(`N° ${doc.numero || ''}`, y - 8, { font: fontBold, size: 8 })
  y -= 10
  centrado(`Timbrado: ${doc.timbradoId || ''}`, y - 8, { size: 6.5 })
  y -= 10
  centrado(`Fecha: ${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, y - 8, { size: 7 })
  y -= 12
  linea(y)
  y -= 6

  // Estado
  const estadoTxt = doc.estado === 'aprobado' ? 'APROBADO POR SET' : `${(doc.estado || '').toUpperCase()}`
  centrado(estadoTxt, y - 8, { font: fontBold, size: 7.5, color: doc.estado === 'aprobado' ? rgb(0.13,0.55,0.13) : rgb(0.75,0.15,0.15) })
  y -= 12
  linea(y)
  y -= 6

  // Receptor
  if (receptor.razonSocial) {
    texto(`Cliente: ${truncar(receptor.razonSocial, 28)}`, margin, y - 8, { size: 7 })
    y -= 10
  }
  if (receptor.documento) {
    const tipoR = receptor.tipo === 1 ? 'RUC' : 'C.I.'
    texto(`${tipoR}: ${receptor.documento}`, margin, y - 8, { size: 7 })
    y -= 10
  }
  y -= 4
  linea(y)
  y -= 6

  // Items header
  texto('Descripción', margin, y - 8, { font: fontBold, size: 7 })
  texto('Total', pageW - margin - 35, y - 8, { font: fontBold, size: 7 })
  y -= 10
  linea(y)
  y -= 4

  // Items
  for (const item of items) {
    texto(truncar(item.descripcion || '', 28), margin, y - 8, { size: 7 })
    const totalStr = formatMoneda(item.precioTotal, moneda)
    const totalW   = fontRegular.widthOfTextAtSize(totalStr, 7)
    texto(totalStr, pageW - margin - totalW, y - 8, { size: 7 })
    y -= 10
    texto(`  ${item.cantidad} x ${formatMoneda(item.precioUnitario, moneda)} | IVA ${item.tasaIVA}%`,
      margin, y - 8, { size: 6, color: COLOR_GRIS })
    y -= 11
  }

  linea(y)
  y -= 6

  // Totales
  const fila = (label, valor) => {
    texto(label, margin, y - 8, { size: 7 })
    const v = String(valor)
    const vW = fontRegular.widthOfTextAtSize(v, 7)
    texto(v, pageW - margin - vW, y - 8, { size: 7 })
    y -= 10
  }

  if (doc.montoExento  > 0) fila('Exentas:', formatMoneda(doc.montoExento, moneda))
  if (doc.montoIva5   > 0) fila('Gravadas 5%:', formatMoneda(doc.montoIva5 * 21, moneda))
  if (doc.montoIva10  > 0) fila('Gravadas 10%:', formatMoneda(doc.montoIva10 * 11, moneda))
  if (doc.montoIva5   > 0) fila('IVA 5%:', formatMoneda(doc.montoIva5, moneda))
  if (doc.montoIva10  > 0) fila('IVA 10%:', formatMoneda(doc.montoIva10, moneda))

  linea(y)
  y -= 4
  texto(`TOTAL ${moneda}`, margin, y - 10, { font: fontBold, size: 9 })
  const totalFinalStr = formatMoneda(doc.montoTotal, moneda)
  const tfW = fontBold.widthOfTextAtSize(totalFinalStr, 9)
  texto(totalFinalStr, pageW - margin - tfW, y - 10, { font: fontBold, size: 9 })
  y -= 14

  linea(y)
  y -= 8

  // QR
  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2
      page.drawImage(qrImage, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 4
      centrado('Escanear para verificar en SET', y - 8, { size: 6, color: COLOR_GRIS })
      y -= 12
    } catch (e) { /* sin QR */ }
  }

  // CDC
  centrado('CDC:', y - 8, { font: fontBold, size: 5.5 })
  y -= 9
  // CDC en dos líneas por espacio
  centrado((doc.cdc || '').substring(0, 22), y - 8, { size: 5 })
  y -= 8
  centrado((doc.cdc || '').substring(22), y - 8, { size: 5 })
  y -= 10

  linea(y)
  y -= 6
  centrado('NODO — Facturación Electrónica Paraguay', y - 7, { size: 5.5, color: COLOR_GRIS })

  return pdfDoc.save()
}

// ── Función: genera KUDE Ticket 58mm ─────────────────────────────────────────
// Las impresoras de 58mm tienen área imprimible de ~48mm (~136pt)
// Texto más pequeño, sin columna de precio unitario, QR reducido
export async function generarKudeTicket58(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()

  const mmToPt  = mm => mm * 2.8346
  const pageW   = mmToPt(58)   // 164pt

  const payload  = doc.payloadJson || {}
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const moneda   = payload.moneda || 'PYG'
  const tipoDoc  = doc.tipoDocumento || 1

  // Altura dinámica: base + items + espacio QR
  const baseH  = 320
  const itemsH = items.length * 20
  const qrH    = qrBase64 ? mmToPt(48) + 20 : 0   // QR ocupa casi todo el ancho
  const pageH  = baseH + itemsH + qrH
  const page   = pdfDoc.addPage([pageW, pageH])

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const margin = 4   // margen más estrecho para 58mm
  let y = pageH - margin

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const texto = (text, x, yPos, opts = {}) => {
    const { font = fontRegular, size = 6.5, color = COLOR_OSCURO } = opts
    page.drawText(String(text ?? ''), { x, y: yPos, size, font, color })
  }

  const linea = (y1) => {
    page.drawLine({
      start: { x: margin, y: y1 },
      end:   { x: pageW - margin, y: y1 },
      thickness: 0.4, color: COLOR_BORDE,
    })
  }

  const centrado = (text, yPos, opts = {}) => {
    const { font = fontRegular, size = 6.5, color = COLOR_OSCURO } = opts
    const s  = String(text ?? '')
    const w  = font.widthOfTextAtSize(s, size)
    const x  = Math.max(margin, (pageW - w) / 2)
    page.drawText(s, { x, y: yPos, size, font, color })
  }

  // Truncar texto para ancho máximo disponible (~48mm = 136pt - 2*margin)
  const maxW = pageW - margin * 2

  const truncarA = (text, font, size, ancho) => {
    let s = String(text ?? '')
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > ancho) {
      s = s.slice(0, -1)
    }
    return s
  }

  // ── Cabecera ────────────────────────────────────────────────────────────────
  centrado(truncarA(tenant.razonSocial || 'EMPRESA', fontBold, 8, maxW), y - 10, { font: fontBold, size: 8 })
  y -= 12
  centrado(`RUC: ${tenant.ruc || ''}`, y - 7, { size: 6 })
  y -= 9

  // Tipo doc en dos líneas si es largo
  const tipoLabel = TIPOS_DOC[tipoDoc] || 'DOC. ELECTRÓNICO'
  centrado(tipoLabel, y - 7, { font: fontBold, size: 7 })
  y -= 9

  centrado(`N° ${doc.numero || ''}`, y - 7, { font: fontBold, size: 7.5 })
  y -= 9
  centrado(`Timbrado: ${doc.timbradoId || ''}`, y - 7, { size: 5.5 })
  y -= 8
  centrado(`${formatFecha(doc.creadoEn)} ${formatHora(doc.creadoEn)}`, y - 7, { size: 6 })
  y -= 10
  linea(y)
  y -= 5

  // Estado
  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO SET' : `${(doc.estado||'').toUpperCase()}`
  const estadoColor = doc.estado === 'aprobado' ? rgb(0.13, 0.55, 0.13) : rgb(0.75, 0.15, 0.15)
  centrado(estadoTxt, y - 7, { font: fontBold, size: 7, color: estadoColor })
  y -= 10
  linea(y)
  y -= 5

  // Receptor (solo si tiene datos)
  if (receptor.razonSocial) {
    texto(truncarA(`Cliente: ${receptor.razonSocial}`, fontRegular, 6, maxW), margin, y - 7, { size: 6 })
    y -= 9
  }
  if (receptor.documento) {
    const tipoR = receptor.tipo === 1 ? 'RUC' : 'C.I.'
    texto(`${tipoR}: ${receptor.documento}`, margin, y - 7, { size: 6 })
    y -= 9
  }
  linea(y)
  y -= 5

  // ── Items ────────────────────────────────────────────────────────────────────
  // Header: solo Descripción y Total (sin precio unit. — poco espacio)
  texto('Descripción', margin, y - 7, { font: fontBold, size: 6 })
  const thStr = 'Total'
  const thW   = fontBold.widthOfTextAtSize(thStr, 6)
  texto(thStr, pageW - margin - thW, y - 7, { font: fontBold, size: 6 })
  y -= 8
  linea(y)
  y -= 4

  for (const item of items) {
    // Descripción truncada al ancho disponible menos espacio para total
    const totalStr = formatMoneda(item.precioTotal, moneda)
    const totalW   = fontRegular.widthOfTextAtSize(totalStr, 6.5)
    const descDisp = maxW - totalW - 4
    const descTxt  = truncarA(item.descripcion || '', fontRegular, 6, descDisp)
    texto(descTxt, margin, y - 7, { size: 6 })
    texto(totalStr, pageW - margin - totalW, y - 7, { size: 6.5 })
    y -= 9

    // Cant x Precio | IVA — en línea más pequeña
    const detalle = `${item.cantidad} x ${formatMoneda(item.precioUnitario, moneda)} | IVA ${item.tasaIVA}%`
    texto(truncarA(detalle, fontRegular, 5.5, maxW), margin, y - 7, { size: 5.5, color: COLOR_GRIS })
    y -= 9
  }

  linea(y)
  y -= 5

  // ── Totales ───────────────────────────────────────────────────────────────────
  const fila = (label, valor, bold = false) => {
    const f = bold ? fontBold : fontRegular
    const sz = bold ? 7.5 : 6.5
    texto(label, margin, y - 7, { font: f, size: sz })
    const v  = String(valor)
    const vW = f.widthOfTextAtSize(v, sz)
    texto(v, pageW - margin - vW, y - 7, { font: f, size: sz })
    y -= bold ? 10 : 9
  }

  if (doc.montoExento > 0) fila('Exentas:',     formatMoneda(doc.montoExento, moneda))
  if (doc.montoIva5   > 0) fila('Grav. 5%:',    formatMoneda(doc.montoIva5 * 21, moneda))
  if (doc.montoIva10  > 0) fila('Grav. 10%:',   formatMoneda(doc.montoIva10 * 11, moneda))
  if (doc.montoIva5   > 0) fila('IVA 5%:',      formatMoneda(doc.montoIva5, moneda))
  if (doc.montoIva10  > 0) fila('IVA 10%:',     formatMoneda(doc.montoIva10, moneda))

  linea(y)
  y -= 3
  fila(`TOTAL ${moneda}:`, formatMoneda(doc.montoTotal, moneda), true)

  linea(y)
  y -= 6

  // ── QR ────────────────────────────────────────────────────────────────────────
  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImage = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2   // QR ocupa todo el ancho útil
      page.drawImage(qrImage, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 4
      centrado('Verificar en SET', y - 7, { size: 5.5, color: COLOR_GRIS })
      y -= 10
    } catch (e) { /* sin QR */ }
  }

  // ── CDC (dividido en 3 líneas de ~15 chars para caber en 58mm) ───────────────
  linea(y)
  y -= 4
  centrado('CDC:', y - 7, { font: fontBold, size: 5 })
  y -= 8
  const cdc = doc.cdc || ''
  centrado(cdc.substring(0, 15),  y - 6, { size: 4.8 })
  y -= 7
  centrado(cdc.substring(15, 30), y - 6, { size: 4.8 })
  y -= 7
  centrado(cdc.substring(30),     y - 6, { size: 4.8 })
  y -= 9

  linea(y)
  y -= 5
  centrado('NODO — Facturación Electrónica', y - 6, { size: 5, color: COLOR_GRIS })

  return pdfDoc.save()
}

// ── Función unificada ─────────────────────────────────────────────────────────
export async function generarKude(doc, tenant, formato = 'a4', qrBase64 = null) {
  if (formato === 'ticket58') {
    return generarKudeTicket58(doc, tenant, qrBase64)
  }
  if (formato === 'ticket' || formato === 'ticket80') {
    return generarKudeTicket(doc, tenant, qrBase64)
  }
  return generarKudeA4(doc, tenant, qrBase64)
}
