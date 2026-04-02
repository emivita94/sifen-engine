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
const C_HEADER_BG  = rgb(0.96, 0.96, 0.96)
const C_VERDE      = rgb(0.10, 0.50, 0.10)
const C_ROJO       = rgb(0.70, 0.10, 0.10)
const C_AZUL       = rgb(0.25, 0.25, 0.25)

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

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function fCDC(cdc) {
  if (!cdc) return ''
  return cdc.replace(/(.{4})/g, '$1 ').trim()
}

function trunc(text, max) {
  const t = String(text ?? '')
  return t.length > max ? t.substring(0, max - 2) + '..' : t
}

// Descargar logo desde URL
async function fetchLogo(url) {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    return Buffer.from(buf)
  } catch (e) {
    return null
  }
}

// ── KUDE A4 ───────────────────────────────────────────────────────────────────
export async function generarKudeA4(doc, tenant, qrBase64 = null) {
  const pdfDoc = await PDFDocument.create()
  const page   = pdfDoc.addPage([595, 842])
  const { width, height } = page.getSize()

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const M  = 25
  const W  = width - M * 2
  let y    = height - M

  // ── Helpers de dibujo ───────────────────────────────────────────────────────
  const t = (text, x, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    page.drawText(s, { x, y: yy, size, font, color })
  }

  const tR = (text, xRight, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: xRight - w, y: yy, size, font, color })
  }

  const tC = (text, x1, x2, yy, opts = {}) => {
    const { font = fReg, size = 7.5, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: x1 + (x2 - x1 - w) / 2, y: yy, size, font, color })
  }

  const ln = (x1, y1, x2, y2, th = 0.4, color = C_BORDE) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: th, color })

  const bx = (x, yy, w, h, opts = {}) => {
    const o = { x, y: yy, width: w, height: h, borderWidth: opts.bw ?? 0.4, opacity: opts.op ?? 1 }
    if (opts.fill)   o.color       = opts.fill
    if (opts.border) o.borderColor = opts.border
    page.drawRectangle(o)
  }

  const payload  = parsePayload(doc)
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const tipoDoc  = doc.tipoDocumento || 1
  const moneda   = payload.moneda || 'PYG'
  const actEcos  = parseActEco(tenant)

  // ── LOGO + CABECERA ─────────────────────────────────────────────────────────
  const logoH   = 70
  const logoW   = W * 0.52
  const timW    = W * 0.48

  // Borde cabecera completa
  bx(M, y - logoH, W, logoH, { border: C_BORDE })
  ln(M + logoW, y, M + logoW, y - logoH)

  // Intentar cargar logo
  const logoUrl = tenant.logoUrl || tenant.logo_url || null
  if (logoUrl) {
    try {
      const logoBytes = await fetchLogo(logoUrl)
      if (logoBytes) {
        let logoImg
        try { logoImg = await pdfDoc.embedPng(logoBytes) } catch (e) {
          try { logoImg = await pdfDoc.embedJpg(logoBytes) } catch (e2) { logoImg = null }
        }
        if (logoImg) {
          const logoMaxH = 30
          const logoMaxW = logoW * 0.45
          const dims = logoImg.scale(1)
          const scale = Math.min(logoMaxW / dims.width, logoMaxH / dims.height)
          const lw = dims.width * scale
          const lh = dims.height * scale
          page.drawImage(logoImg, { x: M + 8, y: y - 8 - lh, width: lw, height: lh })
        }
      }
    } catch (e) { /* sin logo */ }
  }

  // Datos emisor (debajo del logo)
  const emisorY = y - 38
  t(trunc(tenant.razonSocial || tenant.razon_social || '', 45), M + 8, emisorY, { font: fBold, size: 8.5 })
  t(`RUC: ${tenant.ruc || ''}`, M + 8, emisorY - 11, { font: fBold, size: 7.5 })
  t(trunc(tenant.direccion || '', 55), M + 8, emisorY - 21, { size: 7 })

  // Actividades economicas — mostrar todas en lineas separadas
  let actY = emisorY - 31
  for (const act of actEcos) {
    const actTxt = trunc(act.descripcion || '', 58) + '.'
    t(actTxt, M + 8, actY, { size: 6.5, color: C_GRIS })
    actY -= 9
  }
  if (tenant.telefono || tenant.email) {
    const contacto = [tenant.telefono, tenant.email].filter(Boolean).join(' | ')
    t(trunc(contacto, 58), M + 8, actY, { size: 6.5, color: C_GRIS })
  }

  // Lado derecho: Timbrado + Tipo documento + Numero
  const rx = M + logoW + 6
  const rw = M + W - 6

  t('Timbrado', rx, y - 10, { font: fBold, size: 7 })
  tR(String(doc.timbradoNumero || ''), rw, y - 10, { font: fBold, size: 8 })

  t('Fecha Inicio de Vigencia:', rx, y - 21, { size: 7 })
  tR(fFecha(doc.timbradoVigenciaDesde || ''), rw, y - 21, { size: 7 })

  // Linea separadora
  ln(M + logoW, y - 30, M + W, y - 30)

  const tipoLabel = TIPOS_DOC[tipoDoc] || 'DOCUMENTO ELECTRONICO'
  tC(tipoLabel, M + logoW, M + W, y - 43, { font: fBold, size: 9 })
  tC(`N° ${doc.numero || ''}`, M + logoW, M + W, y - 57, { font: fBold, size: 10 })

  y -= logoH

  // ── DATOS DEL DOCUMENTO Y RECEPTOR ─────────────────────────────────────────
  const datH    = 72
  const datColW = W * 0.50
  bx(M, y - datH, W, datH, { border: C_BORDE })
  ln(M + datColW, y, M + datColW, y - datH)

  // Columna izquierda
  const lx = M + 5
  t('Fecha y hora de emision:', lx, y - 9, { font: fBold, size: 7 })
  t(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`, lx, y - 18, { size: 7.5 })

  t('Condicion Venta:', lx, y - 31, { font: fBold, size: 7 })
  t('Contado', lx + 72, y - 31, { size: 7 })

  t('Tipo de Transaccion:', lx, y - 43, { font: fBold, size: 7 })
  t('Venta de mercaderia', lx, y - 53, { size: 7, color: C_GRIS })

  t('Moneda:', lx, y - 63, { font: fBold, size: 7 })
  t(moneda, lx + 38, y - 63, { size: 7 })

  // Columna derecha: receptor
  const rx2 = M + datColW + 5
  const tipR = tipoDocRec(receptor.tipo)
  if (tipR) {
    t(`${tipR}:`, rx2, y - 9, { font: fBold, size: 7 })
    t(receptor.documento || '', rx2 + 35, y - 9, { size: 7.5 })
  }
  t('Razon Social:', rx2, y - 21, { font: fBold, size: 7 })
  t(trunc(receptor.razonSocial || 'CONSUMIDOR FINAL', 38), rx2, y - 30, { size: 7.5 })
  if (receptor.email) {
    t('Email:', rx2, y - 41, { font: fBold, size: 7 })
    t(trunc(receptor.email, 38), rx2, y - 50, { size: 7 })
  }

  y -= datH

  // ── TABLA DE ITEMS ──────────────────────────────────────────────────────────
  // Columnas
  const cols = [
    { key: 'cod',    label: 'Cod.',        x: M,              w: W * 0.065, align: 'c' },
    { key: 'desc',   label: 'Descripcion', x: M + W * 0.065,  w: W * 0.33,  align: 'l' },
    { key: 'uni',    label: 'U.Med.',      x: M + W * 0.395,  w: W * 0.065, align: 'c' },
    { key: 'cant',   label: 'Cant.',       x: M + W * 0.460,  w: W * 0.065, align: 'r' },
    { key: 'precio', label: 'Precio Unit.',x: M + W * 0.525,  w: W * 0.12,  align: 'r' },
    { key: 'dsc',    label: 'Desc/Antic.', x: M + W * 0.645,  w: W * 0.085, align: 'r' },
    { key: 'exenta', label: 'Exentas',     x: M + W * 0.730,  w: W * 0.09,  align: 'r' },
    { key: 'iva5',   label: '5%',          x: M + W * 0.820,  w: W * 0.085, align: 'r' },
    { key: 'iva10',  label: '10%',         x: M + W * 0.905,  w: W * 0.095, align: 'r' },
  ]

  const thH  = 14
  const rowH = 12

  // Header tabla
  bx(M, y - thH, W, thH, { fill: C_AZUL })
  for (const col of cols) {
    if (col.align === 'c') tC(col.label, col.x, col.x + col.w, y - 4.5, { font: fBold, size: 6, color: C_BLANCO })
    else if (col.align === 'r') tR(col.label, col.x + col.w - 2, y - 4.5, { font: fBold, size: 6, color: C_BLANCO })
    else t(col.label, col.x + 2, y - 4.5, { font: fBold, size: 6, color: C_BLANCO })
  }
  // Lineas verticales header
  for (const col of cols) ln(col.x, y, col.x, y - thH, 0.3, C_BLANCO)
  ln(M + W, y, M + W, y - thH, 0.3, C_BLANCO)
  y -= thH

  // Filas items
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (i % 2 === 0) bx(M, y - rowH, W, rowH, { fill: C_GRIS_CLARO })

    const exenta = item.tasaIVA === 0  ? Number(item.precioTotal) : 0
    const grav5  = item.tasaIVA === 5  ? Number(item.precioTotal) : 0
    const grav10 = item.tasaIVA === 10 ? Number(item.precioTotal) : 0

    tC(String(i + 1).padStart(3, '0'), cols[0].x, cols[0].x + cols[0].w, y - 8, { size: 6.5 })
    t(trunc(item.descripcion || '', 46), cols[1].x + 2, y - 8, { size: 6.5 })
    tC('UNI', cols[2].x, cols[2].x + cols[2].w, y - 8, { size: 6.5 })
    tR(String(item.cantidad), cols[3].x + cols[3].w - 2, y - 8, { size: 6.5 })
    tR(formatNum(item.precioUnitario, moneda), cols[4].x + cols[4].w - 2, y - 8, { size: 6.5 })
    tR('0', cols[5].x + cols[5].w - 2, y - 8, { size: 6.5 })
    tR(exenta > 0 ? formatNum(exenta, moneda) : '0', cols[6].x + cols[6].w - 2, y - 8, { size: 6.5 })
    tR(grav5  > 0 ? formatNum(grav5,  moneda) : '0', cols[7].x + cols[7].w - 2, y - 8, { size: 6.5 })
    tR(grav10 > 0 ? formatNum(grav10, moneda) : '0', cols[8].x + cols[8].w - 2, y - 8, { size: 6.5 })

    // Bordes fila
    for (const col of cols) ln(col.x, y, col.x, y - rowH, 0.3, C_BORDE)
    ln(M + W, y, M + W, y - rowH, 0.3, C_BORDE)
    ln(M, y - rowH, M + W, y - rowH, 0.3, C_BORDE)
    y -= rowH
  }

  // Filas vacías (mínimo 5)
  const emptyRows = Math.max(0, 5 - items.length)
  for (let i = 0; i < emptyRows; i++) {
    for (const col of cols) ln(col.x, y, col.x, y - rowH, 0.3, C_BORDE)
    ln(M + W, y, M + W, y - rowH, 0.3, C_BORDE)
    ln(M, y - rowH, M + W, y - rowH, 0.3, C_BORDE)
    y -= rowH
  }

  // ── TOTALES ─────────────────────────────────────────────────────────────────
  // Calcular desde items (fuente de verdad)
  let totExenta = 0, totGrav5 = 0, totGrav10 = 0
  for (const item of items) {
    if (item.tasaIVA === 0)  totExenta += Number(item.precioTotal)
    if (item.tasaIVA === 5)  totGrav5  += Number(item.precioTotal)
    if (item.tasaIVA === 10) totGrav10 += Number(item.precioTotal)
  }
  const totalGen  = totExenta + totGrav5 + totGrav10 || Number(doc.montoTotal) || 0
  const iva5amt   = Number(doc.montoIva5)  || 0
  const iva10amt  = Number(doc.montoIva10) || 0

  // Columnas de subtotales (alineadas con la tabla)
  const stCols = {
    exenta: cols[6],
    iva5:   cols[7],
    iva10:  cols[8],
  }

  const stH = 13
  // SUBTOTALES
  bx(M, y - stH, W, stH, { fill: C_GRIS_CLARO, border: C_BORDE })
  t('SUBTOTALES:', M + 5, y - 8, { font: fBold, size: 7 })
  for (const [k, col] of Object.entries(stCols)) ln(col.x, y, col.x, y - stH, 0.3, C_BORDE)
  ln(M + W, y, M + W, y - stH, 0.3, C_BORDE)
  tR(formatNum(totExenta, moneda), stCols.exenta.x + stCols.exenta.w - 2, y - 8, { size: 7 })
  tR(formatNum(totGrav5,  moneda), stCols.iva5.x   + stCols.iva5.w   - 2, y - 8, { size: 7 })
  tR(formatNum(totGrav10, moneda), stCols.iva10.x  + stCols.iva10.w  - 2, y - 8, { size: 7 })
  y -= stH

  // SUMA TOTAL
  bx(M, y - stH, W, stH, { border: C_BORDE })
  t('SUMA TOTAL:', M + 5, y - 8, { font: fBold, size: 7 })
  tR(formatNum(totalGen, moneda), M + W - 4, y - 8, { font: fBold, size: 8 })
  y -= stH

  // DESCUENTO GLOBAL
  bx(M, y - stH, W, stH, { border: C_BORDE })
  t('DESCUENTO/ANTICIPO GLOBAL:', M + 5, y - 8, { size: 7 })
  tR('0', M + W - 4, y - 8, { size: 7 })
  y -= stH

  // TOTAL DE LA OPERACION
  bx(M, y - stH, W, stH, { fill: C_AZUL, border: C_BORDE })
  t('TOTAL DE LA OPERACION:', M + 5, y - 8, { font: fBold, size: 8, color: C_BLANCO })
  tR(formatNum(totalGen, moneda), M + W - 4, y - 8, { font: fBold, size: 9, color: C_BLANCO })
  y -= stH

  // EN LETRAS
  bx(M, y - stH, W, stH, { border: C_BORDE })
  t('EN LETRAS: GUARANIES ' + numALetras(totalGen), M + 5, y - 8, { size: 6.5, color: C_GRIS })
  y -= stH

  // LIQUIDACION IVA
  const ivaH    = 16
  const ivaColW = W / 3
  bx(M, y - ivaH, W, ivaH, { border: C_BORDE })
  t('LIQUIDACION IVA:', M + 5, y - 5, { font: fBold, size: 7 })
  t(`(5%)  ${formatNum(iva5amt, moneda)}`, M + 5, y - 13, { size: 7 })
  t(`(10%)  ${formatNum(iva10amt, moneda)}`, M + ivaColW, y - 13, { size: 7 })
  t(`Total IVA:  ${formatNum(iva5amt + iva10amt, moneda)}`, M + ivaColW * 2, y - 13, { font: fBold, size: 7 })
  y -= ivaH

  // ── QR + CDC ─────────────────────────────────────────────────────────────────
  y -= 8
  const qrSize = 78
  const cdcX   = M + qrSize + 12

  if (qrBase64) {
    try {
      const qrData  = String(qrBase64)
      const qrB64   = qrData.includes('base64,') ? qrData.split('base64,')[1] : qrData
      const qrBytes = Buffer.from(qrB64, 'base64')
      const qrImg   = await pdfDoc.embedPng(qrBytes)
      page.drawImage(qrImg, { x: M, y: y - qrSize, width: qrSize, height: qrSize })
    } catch (e) { console.log('QR embed error A4:', e.message) }
  }

  t('Consulte la validez de este Documento Electronico con el numero de CDC impreso', cdcX, y - 8, { size: 6.5, color: C_GRIS })
  t('https://ekuatia.set.gov.py/consultas', cdcX, y - 17, { size: 6.5, color: C_GRIS })

  // CDC en dos líneas - 22 caracteres del CDC original por linea
  const cdcRaw  = doc.cdc || ''
  const cdc1    = fCDC(cdcRaw.substring(0, 22))
  const cdc2    = fCDC(cdcRaw.substring(22))
  t('CDC:', cdcX, y - 30, { font: fBold, size: 7 })
  t(cdc1, cdcX, y - 41, { font: fBold, size: 8 })
  t(cdc2, cdcX, y - 52, { font: fBold, size: 8 })

  const estadoColor = doc.estado === 'aprobado' ? C_VERDE : C_ROJO
  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO POR LA SET' : (doc.estado || '').toUpperCase()
  t(estadoTxt, cdcX, y - 65, { font: fBold, size: 8.5, color: estadoColor })
  if (doc.estado === 'aprobado') {
    t(`Fecha: ${fFecha(doc.sifenRespEn)} ${fHora(doc.sifenRespEn)}`, cdcX, y - 75, { size: 7, color: C_GRIS })
  }

  y -= qrSize + 10

  // ── PIE ──────────────────────────────────────────────────────────────────────
  ln(M, y, M + W, y, 0.5, C_BORDE)
  y -= 9
  t('Si su documento electronico presenta algun error puede solicitar la modificacion dentro de las 72 horas siguientes de la emision de este comprobante.', M, y, { size: 5.8, color: C_GRIS })
  y -= 9
  t('ESTE DOCUMENTO ES UNA REPRESENTACION GRAFICA DE UN DOCUMENTO ELECTRONICO (XML)', M, y, { font: fBold, size: 6.5 })
  y -= 9
  t('Generado por NODO - Plataforma de Facturacion Electronica Paraguay | nodo.com.py', M, y, { size: 6, color: C_GRIS })

  return pdfDoc.save()
}

// ── Número a letras (simplificado para guaraníes) ─────────────────────────────
function numALetras(n) {
  const num = Math.round(Number(n) || 0)
  if (num === 0) return 'CERO'
  const unidades = ['','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE',
    'DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISEIS','DIECISIETE','DIECIOCHO','DIECINUEVE']
  const decenas  = ['','','VEINTE','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA']
  const centenas = ['','CIEN','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS',
    'SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS']

  function grupo(n) {
    let s = ''
    if (n >= 100) { s += centenas[Math.floor(n/100)] + (n%100 > 0 ? ' ' : ''); n = n%100 }
    if (n >= 20)  { s += decenas[Math.floor(n/10)] + (n%10 > 0 ? ' Y ' : ''); n = n%10 }
    if (n > 0)    { s += unidades[n] }
    return s.trim()
  }

  if (num < 1000) return grupo(num)
  if (num < 1000000) {
    const mil = Math.floor(num/1000)
    const res = num % 1000
    return (mil === 1 ? 'MIL' : grupo(mil) + ' MIL') + (res > 0 ? ' ' + grupo(res) : '')
  }
  const mill = Math.floor(num/1000000)
  const res  = num % 1000000
  return (mill === 1 ? 'UN MILLON' : grupo(mill) + ' MILLONES') + (res > 0 ? ' ' + numALetras(res) : '')
}

// ── KUDE Ticket 58mm ──────────────────────────────────────────────────────────
export async function generarKudeTicket58(doc, tenant, qrBase64 = null) {
  const pdfDoc   = await PDFDocument.create()
  const mmToPt   = mm => mm * 2.8346
  const pageW    = mmToPt(58)   // 164pt
  const payload  = parsePayload(doc)
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const moneda   = payload.moneda || 'PYG'
  const tipoDoc  = doc.tipoDocumento || 1
  const actEcos  = parseActEco(tenant)

  // Calcular altura dinamica
  const baseH   = 260
  const itemsH  = items.length * 24
  const actH    = actEcos.length * 8
  const qrH     = qrBase64 ? pageW + 10 : 0
  const pageH   = baseH + itemsH + actH + qrH
  const page    = pdfDoc.addPage([pageW, pageH])

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const margin = 5
  let y = pageH - margin
  const maxW = pageW - margin * 2

  const t = (text, x, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    page.drawText(s, { x, y: yy, size, font, color })
  }

  const tC = (text, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: Math.max(margin, (pageW - w) / 2), y: yy, size, font, color })
  }

  const tR = (text, xRight, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: xRight - w, y: yy, size, font, color })
  }

  const ln = (y1) => page.drawLine({
    start: { x: margin, y: y1 }, end: { x: pageW - margin, y: y1 },
    thickness: 0.4, color: C_BORDE
  })

  const trA = (text, font, size, maxW) => {
    let s = String(text ?? '')
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1)
    return s
  }

  // ── Logo ────────────────────────────────────────────────────────────────────
  const logoUrl = tenant.logoUrl || tenant.logo_url || null
  if (logoUrl) {
    try {
      const logoBytes = await fetchLogo(logoUrl)
      if (logoBytes) {
        let logoImg
        try { logoImg = await pdfDoc.embedPng(logoBytes) } catch (e) {
          try { logoImg = await pdfDoc.embedJpg(logoBytes) } catch (e2) { logoImg = null }
        }
        if (logoImg) {
          const logoMaxH = 25
          const logoMaxW = pageW * 0.55
          const dims = logoImg.scale(1)
          const scale = Math.min(logoMaxW / dims.width, logoMaxH / dims.height)
          const lw = dims.width * scale
          const lh = dims.height * scale
          page.drawImage(logoImg, { x: (pageW - lw) / 2, y: y - lh, width: lw, height: lh })
          y -= lh + 4
        }
      }
    } catch (e) { /* sin logo */ }
  }

  // ── Cabecera ─────────────────────────────────────────────────────────────────
  tC(trA(tenant.razonSocial || tenant.razon_social || '', fBold, 8, maxW), y - 9, { font: fBold, size: 8 })
  y -= 11
  tC(`RUC: ${tenant.ruc || ''}`, y - 7, { size: 7 })
  y -= 9
  tC(trA(tenant.direccion || '', fReg, 6.5, maxW), y - 7, { size: 6.5, color: C_GRIS })
  y -= 9

  // Actividades economicas completas
  for (const act of actEcos) {
    tC(trA(act.descripcion || '', fReg, 6, maxW), y - 6, { size: 6, color: C_GRIS })
    y -= 8
  }

  ln(y); y -= 5

  // Tipo doc y numero
  tC(TIPOS_DOC[tipoDoc] || 'DOC. ELECTRONICO', y - 7, { font: fBold, size: 7.5 })
  y -= 10
  tC(`N° ${doc.numero || ''}`, y - 7, { font: fBold, size: 9 })
  y -= 12
  tC(`Timbrado: ${doc.timbradoNumero || ''}`, y - 7, { size: 6.5 })
  y -= 9
  tC(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`, y - 7, { size: 7 })
  y -= 10

  ln(y); y -= 5

  // Estado
  const estadoTxt   = doc.estado === 'aprobado' ? 'APROBADO SET' : (doc.estado || '').toUpperCase()
  const estadoColor = doc.estado === 'aprobado' ? C_VERDE : C_ROJO
  tC(estadoTxt, y - 7, { font: fBold, size: 8, color: estadoColor })
  y -= 11
  ln(y); y -= 5

  // Receptor
  const tipR = tipoDocRec(receptor.tipo)
  if (tipR && receptor.documento) {
    t(`${tipR}: ${receptor.documento}`, margin, y - 7, { size: 6.5 })
    y -= 9
  }
  if (receptor.razonSocial) {
    t(trA(`Cliente: ${receptor.razonSocial}`, fReg, 6.5, maxW), margin, y - 7, { size: 6.5 })
    y -= 9
  }
  ln(y); y -= 4

  // ── Items ────────────────────────────────────────────────────────────────────
  // Header
  t('Descripcion', margin, y - 7, { font: fBold, size: 6.5 })
  tR('IVA%', pageW - margin - 30, y - 7, { font: fBold, size: 6 })
  tR('Total', pageW - margin, y - 7, { font: fBold, size: 6.5 })
  y -= 9
  ln(y); y -= 4

  let calcTotExenta = 0, calcTotGrav5 = 0, calcTotGrav10 = 0

  for (const item of items) {
    const totalStr = formatNum(item.precioTotal, moneda)
    const totalW   = fReg.widthOfTextAtSize(totalStr, 7)
    const ivaStr   = `${item.tasaIVA}%`
    const ivaW     = fReg.widthOfTextAtSize(ivaStr, 6)
    const descDisp = maxW - totalW - ivaW - 8

    let desc = String(item.descripcion || '')
    while (desc.length > 0 && fReg.widthOfTextAtSize(desc, 6.5) > descDisp) desc = desc.slice(0, -1)

    t(desc, margin, y - 7, { size: 6.5 })
    tR(ivaStr, pageW - margin - totalW - 4, y - 7, { size: 6, color: C_GRIS })
    tR(totalStr, pageW - margin, y - 7, { size: 7 })
    y -= 9

    // Segunda línea: cant x precio
    const det = `${item.cantidad} x ${formatNum(item.precioUnitario, moneda)}`
    t(trA(det, fReg, 6, maxW), margin, y - 7, { size: 6, color: C_GRIS })
    y -= 9

    // Acumular totales
    if (item.tasaIVA === 0)  calcTotExenta += Number(item.precioTotal)
    if (item.tasaIVA === 5)  calcTotGrav5  += Number(item.precioTotal)
    if (item.tasaIVA === 10) calcTotGrav10 += Number(item.precioTotal)
  }

  const totalGen = calcTotExenta + calcTotGrav5 + calcTotGrav10 || Number(doc.montoTotal) || 0
  const iva5a    = Number(doc.montoIva5)  || 0
  const iva10a   = Number(doc.montoIva10) || 0

  ln(y); y -= 4

  // ── Totales ──────────────────────────────────────────────────────────────────
  const fila = (label, valor, bold = false) => {
    const f  = bold ? fBold : fReg
    const sz = bold ? 8 : 7
    t(label, margin, y - 7, { font: f, size: sz })
    tR(String(valor), pageW - margin, y - 7, { font: f, size: sz })
    y -= bold ? 11 : 9
  }

  if (calcTotExenta > 0) fila('Exentas:',   formatNum(calcTotExenta, moneda))
  if (calcTotGrav5  > 0) {
    fila('Gravadas 5%:', formatNum(calcTotGrav5, moneda))
    fila('IVA 5%:',      formatNum(iva5a, moneda))
  }
  if (calcTotGrav10 > 0) {
    fila('Gravadas 10%:', formatNum(calcTotGrav10, moneda))
    fila('IVA 10%:',      formatNum(iva10a, moneda))
  }

  ln(y); y -= 3
  fila(`TOTAL ${moneda}:`, formatNum(totalGen, moneda), true)
  ln(y); y -= 8

  // ── QR ────────────────────────────────────────────────────────────────────────
  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImg   = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2
      page.drawImage(qrImg, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 5
      tC('Verificar en ekuatia.set.gov.py', y - 7, { size: 5.5, color: C_GRIS })
      y -= 10
    } catch (e) { /* sin QR */ }
  }

  // ── CDC ───────────────────────────────────────────────────────────────────────
  ln(y); y -= 5
  tC('CDC:', y - 7, { font: fBold, size: 6 }); y -= 9
  const cdc = doc.cdc || ''
  tC(cdc.substring(0, 11),  y - 6, { size: 5.5 }); y -= 8
  tC(cdc.substring(11, 22), y - 6, { size: 5.5 }); y -= 8
  tC(cdc.substring(22, 33), y - 6, { size: 5.5 }); y -= 8
  tC(cdc.substring(33),     y - 6, { size: 5.5 }); y -= 10

  ln(y); y -= 6
  tC('NODO - Facturacion Electronica Paraguay', y - 6, { size: 5.5, color: C_GRIS })

  return pdfDoc.save()
}

// ── KUDE Ticket 80mm ──────────────────────────────────────────────────────────
export async function generarKudeTicket(doc, tenant, qrBase64 = null) {
  // Para 80mm usamos el mismo que 58mm pero con mas ancho
  const pdfDoc   = await PDFDocument.create()
  const mmToPt   = mm => mm * 2.8346
  const pageW    = mmToPt(80)
  const payload  = parsePayload(doc)
  const items    = payload.items || []
  const receptor = payload.receptor || {}
  const moneda   = payload.moneda || 'PYG'
  const tipoDoc  = doc.tipoDocumento || 1
  const actEcos  = parseActEco(tenant)

  const baseH  = 300
  const itemsH = items.length * 22
  const qrH    = qrBase64 ? pageW + 10 : 0
  const pageH  = baseH + itemsH + qrH
  const page   = pdfDoc.addPage([pageW, pageH])

  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica)

  const margin = 6
  let y = pageH - margin
  const maxW = pageW - margin * 2

  const t = (text, x, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    page.drawText(s, { x, y: yy, size, font, color })
  }
  const tC = (text, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: Math.max(margin, (pageW - w) / 2), y: yy, size, font, color })
  }
  const tR = (text, xRight, yy, opts = {}) => {
    const { font = fReg, size = 7, color = C_NEGRO } = opts
    const s = String(text ?? '')
    if (!s) return
    const w = font.widthOfTextAtSize(s, size)
    page.drawText(s, { x: xRight - w, y: yy, size, font, color })
  }
  const ln = (y1) => page.drawLine({ start: { x: margin, y: y1 }, end: { x: pageW - margin, y: y1 }, thickness: 0.4, color: C_BORDE })
  const trA = (text, font, size) => {
    let s = String(text ?? '')
    while (s.length > 0 && font.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1)
    return s
  }

  // Logo
  const logoUrl = tenant.logoUrl || tenant.logo_url || null
  if (logoUrl) {
    try {
      const logoBytes = await fetchLogo(logoUrl)
      if (logoBytes) {
        let logoImg
        try { logoImg = await pdfDoc.embedPng(logoBytes) } catch (e) {
          try { logoImg = await pdfDoc.embedJpg(logoBytes) } catch (e2) { logoImg = null }
        }
        if (logoImg) {
          const logoMaxH = 28
          const logoMaxW = pageW * 0.6
          const dims = logoImg.scale(1)
          const scale = Math.min(logoMaxW / dims.width, logoMaxH / dims.height)
          const lw = dims.width * scale
          const lh = dims.height * scale
          page.drawImage(logoImg, { x: (pageW - lw) / 2, y: y - lh, width: lw, height: lh })
          y -= lh + 4
        }
      }
    } catch (e) { /* sin logo */ }
  }

  tC(trA(tenant.razonSocial || tenant.razon_social || '', fBold, 9), y - 10, { font: fBold, size: 9 }); y -= 13
  tC(`RUC: ${tenant.ruc || ''}`, y - 7, { size: 7.5 }); y -= 10
  tC(trA(tenant.direccion || '', fReg, 7), y - 7, { size: 7, color: C_GRIS }); y -= 10
  for (const act of actEcos) { tC(trA(act.descripcion || '', fReg, 6.5), y - 7, { size: 6.5, color: C_GRIS }); y -= 9 }

  ln(y); y -= 6
  tC(TIPOS_DOC[tipoDoc] || 'DOC. ELECTRONICO', y - 7, { font: fBold, size: 8 }); y -= 11
  tC(`N° ${doc.numero || ''}`, y - 7, { font: fBold, size: 9.5 }); y -= 13
  tC(`Timbrado: ${doc.timbradoNumero || ''}`, y - 7, { size: 7 }); y -= 9
  tC(`${fFecha(doc.creadoEn)} ${fHora(doc.creadoEn)}`, y - 7, { size: 7 }); y -= 11

  ln(y); y -= 6
  const eTxt   = doc.estado === 'aprobado' ? 'APROBADO SET' : (doc.estado || '').toUpperCase()
  const eColor = doc.estado === 'aprobado' ? C_VERDE : C_ROJO
  tC(eTxt, y - 7, { font: fBold, size: 8, color: eColor }); y -= 11
  ln(y); y -= 6

  const tipR = tipoDocRec(receptor.tipo)
  if (tipR && receptor.documento) { t(`${tipR}: ${receptor.documento}`, margin, y - 7, { size: 7 }); y -= 10 }
  if (receptor.razonSocial) { t(trA(`Cliente: ${receptor.razonSocial}`, fReg, 7), margin, y - 7, { size: 7 }); y -= 10 }
  ln(y); y -= 5

  t('Descripcion', margin, y - 7, { font: fBold, size: 7 })
  tR('Total', pageW - margin, y - 7, { font: fBold, size: 7 })
  y -= 9; ln(y); y -= 4

  let cTotExenta = 0, cTotGrav5 = 0, cTotGrav10 = 0
  for (const item of items) {
    const totalStr = formatNum(item.precioTotal, moneda)
    const totalW   = fReg.widthOfTextAtSize(totalStr, 7.5)
    let desc = String(item.descripcion || '')
    while (desc.length > 0 && fReg.widthOfTextAtSize(desc, 7) > maxW - totalW - 6) desc = desc.slice(0, -1)
    t(desc, margin, y - 7, { size: 7 })
    tR(totalStr, pageW - margin, y - 7, { size: 7.5 })
    y -= 10
    const det = `${item.cantidad} x ${formatNum(item.precioUnitario, moneda)} | IVA ${item.tasaIVA}%`
    t(trA(det, fReg, 6.5), margin, y - 7, { size: 6.5, color: C_GRIS }); y -= 10
    if (item.tasaIVA === 0)  cTotExenta += Number(item.precioTotal)
    if (item.tasaIVA === 5)  cTotGrav5  += Number(item.precioTotal)
    if (item.tasaIVA === 10) cTotGrav10 += Number(item.precioTotal)
  }

  const totGen = cTotExenta + cTotGrav5 + cTotGrav10 || Number(doc.montoTotal) || 0
  const iva5b  = Number(doc.montoIva5)  || 0
  const iva10b = Number(doc.montoIva10) || 0

  ln(y); y -= 5
  const filaT = (label, valor, bold = false) => {
    const f = bold ? fBold : fReg; const sz = bold ? 8.5 : 7.5
    t(label, margin, y - 7, { font: f, size: sz })
    tR(String(valor), pageW - margin, y - 7, { font: f, size: sz })
    y -= bold ? 12 : 10
  }
  if (cTotExenta > 0) filaT('Exentas:', formatNum(cTotExenta, moneda))
  if (cTotGrav5  > 0) { filaT('Gravadas 5%:', formatNum(cTotGrav5, moneda)); filaT('IVA 5%:', formatNum(iva5b, moneda)) }
  if (cTotGrav10 > 0) { filaT('Gravadas 10%:', formatNum(cTotGrav10, moneda)); filaT('IVA 10%:', formatNum(iva10b, moneda)) }
  ln(y); y -= 3
  filaT(`TOTAL ${moneda}:`, formatNum(totGen, moneda), true)
  ln(y); y -= 10

  if (qrBase64) {
    try {
      const qrBytes = Buffer.from(qrBase64.replace(/^data:image\/png;base64,/, ''), 'base64')
      const qrImg   = await pdfDoc.embedPng(qrBytes)
      const qrSize  = pageW - margin * 2
      page.drawImage(qrImg, { x: margin, y: y - qrSize, width: qrSize, height: qrSize })
      y -= qrSize + 5
      tC('Verificar en ekuatia.set.gov.py', y - 7, { size: 6, color: C_GRIS }); y -= 10
    } catch (e) { /* sin QR */ }
  }

  ln(y); y -= 5
  tC('CDC:', y - 7, { font: fBold, size: 6.5 }); y -= 9
  const cdc = doc.cdc || ''
  tC(cdc.substring(0, 15),  y - 6, { size: 6 }); y -= 8
  tC(cdc.substring(15, 30), y - 6, { size: 6 }); y -= 8
  tC(cdc.substring(30),     y - 6, { size: 6 }); y -= 10
  ln(y); y -= 6
  tC('NODO - Facturacion Electronica Paraguay', y - 6, { size: 6, color: C_GRIS })

  return pdfDoc.save()
}

// ── Funcion unificada ─────────────────────────────────────────────────────────
export async function generarKude(doc, tenant, formato = 'a4', qrBase64 = null) {
  if (formato === 'ticket58')                         return generarKudeTicket58(doc, tenant, qrBase64)
  if (formato === 'ticket' || formato === 'ticket80') return generarKudeTicket(doc, tenant, qrBase64)
  return generarKudeA4(doc, tenant, qrBase64)
}
