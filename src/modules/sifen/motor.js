// src/modules/sifen/motor.js
import { getDb } from '../../db/connection.js'
import { desencriptar } from '../../shared/crypto/index.js'
import { config } from '../../config/index.js'
import { dispararWebhook } from './webhooks.js'
import { respuestaDE, respuestaError } from './respuestas.js'
import { writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

let _xmlgen, _xmlsign, _setapi, _qrgen

async function cargarLibrerias() {
  if (_xmlgen) return
  try {
    const modXmlgen  = await import('facturacionelectronicapy-xmlgen')
    const modXmlsign = await import('facturacionelectronicapy-xmlsign')
    const modSetapi  = await import('facturacionelectronicapy-setapi')
    const modQrgen   = await import('facturacionelectronicapy-qrgen')
    _xmlgen  = modXmlgen.default?.default  || modXmlgen.default  || modXmlgen
    _xmlsign = modXmlsign.default?.default || modXmlsign.default || modXmlsign
    _setapi  = modSetapi.default?.default  || modSetapi.default  || modSetapi
    _qrgen   = modQrgen.default?.default   || modQrgen.default   || modQrgen
  } catch (e) {
    throw new Error('Error cargando librerías SIFEN: ' + e.message)
  }
}

// Paraguay = UTC-3
function ahoraParaguay() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000)
}

// Esperar N milisegundos
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function procesarDocumento(tenantId, payload) {
  await cargarLibrerias()
  const sql = getDb()

  // ── 1. Tenant ───────────────────────────────────────────────────────────────
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_alias,
           codigo_seguridad, cert_password,
           direccion, numero_casa, departamento, departamento_desc,
           distrito, distrito_desc, ciudad, ciudad_desc,
           telefono, email, denominacion, csc, id_csc,
           actividades_economicas, tipo_contribuyente, tipo_regimen,
           nombre_fantasia
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)                return respuestaError('Tenant no encontrado o inactivo')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')
  if (!tenant.csc)            return respuestaError('El tenant no tiene CSC configurado')
  if (!tenant.direccion)      return respuestaError('El tenant no tiene dirección configurada')

  // ── 2. Timbrado activo ──────────────────────────────────────────────────────
  const tipoDoc = payload.tipoDocumento || 1
  const [timbrado] = await sql`
    SELECT t.*, e.codigo AS est_codigo, e.direccion AS est_direccion,
           e.ciudad_codigo, e.ciudad_nombre, e.departamento_codigo,
           p.codigo AS punto_codigo
    FROM timbrados t
    JOIN establecimientos e ON e.id = t.establecimiento_id
    JOIN puntos_expedicion p ON p.id = t.punto_id
    WHERE t.tenant_id = ${tenantId}
      AND t.tipo_documento = ${tipoDoc}
      AND t.activo = true
      AND t.vigencia_desde <= CURRENT_DATE
      AND t.vigencia_hasta >= CURRENT_DATE
      AND t.numero_actual <= t.numero_max
    ORDER BY t.vigencia_hasta DESC LIMIT 1
  `
  if (!timbrado) return respuestaError(`Sin timbrado activo para tipo de documento ${tipoDoc}`)

  // ── 3. Número secuencial atómico ────────────────────────────────────────────
  const [{ numeroActual }] = await sql`
    UPDATE timbrados SET numero_actual = numero_actual + 1
    WHERE id = ${timbrado.id}
    RETURNING numero_actual - 1 AS numero_actual
  `
  const numeroSecuencia  = Number(numeroActual)
  const estCodigo        = timbrado.estCodigo.toString().padStart(3, '0')
  const puntoCodigo      = timbrado.puntoCodigo.toString().padStart(3, '0')
  const numeroFormateado = `${estCodigo}-${puntoCodigo}-${numeroSecuencia.toString().padStart(7, '0')}`
  const fechaEmision     = payload.fecha ? new Date(payload.fecha) : ahoraParaguay()
  const codigoSeguridad  = Math.floor(100000000 + Math.random() * 900000000).toString()
  const idCSC            = tenant.idCsc || '0001'

  // ── 4. Params ───────────────────────────────────────────────────────────────
 const timbradoFecha = timbrado.vigenciaDesde instanceof Date
  ? timbrado.vigenciaDesde.toISOString().split('T')[0]
  : String(timbrado.vigenciaDesde).split('T')[0]

  const actividadesEconomicas = Array.isArray(tenant.actividadesEconomicas) && tenant.actividadesEconomicas.length > 0
    ? tenant.actividadesEconomicas
    : [{ codigo: '00000', descripcion: 'SIN ACTIVIDAD CONFIGURADA' }]

  const params = {
    version:               150,
    ruc:                   tenant.ruc,
    razonSocial:           tenant.razonSocial,
    nombreFantasia:        tenant.nombreFantasia || tenant.razonSocial,
    actividadesEconomicas,
    timbradoNumero:        timbrado.numeroTimbrado,
    timbradoFecha,
    tipoContribuyente:     tenant.tipoContribuyente || 2,
    tipoRegimen:           tenant.tipoRegimen       || 8,
    establecimientos: [{
      codigo:                  estCodigo,
      direccion:               tenant.direccion        || '',
      numeroCasa:              tenant.numeroCasa       || '0',
      departamento:            tenant.departamento     || 1,
      departamentoDescripcion: tenant.departamentoDesc || 'CAPITAL',
      distrito:                tenant.distrito         || 1,
      distritoDescripcion:     tenant.distritoDesc     || 'ASUNCION (DISTRITO)',
      ciudad:                  tenant.ciudad           || 1,
      ciudadDescripcion:       tenant.ciudadDesc       || 'ASUNCION (DISTRITO)',
      telefono:                tenant.telefono         || '',
      email:                   tenant.email            || '',
      denominacion:            tenant.denominacion     || '',
    }],
  }

  // ── 5. Data ─────────────────────────────────────────────────────────────────
  const receptor        = payload.receptor || {}
  const esContribuyente = receptor.tipo === 1
  const esInnominado    = receptor.tipo === 4 || !receptor.tipo

  let clienteData = {}
  if (esInnominado) {
    clienteData = {
      contribuyente: false, documentoTipo: 5, documentoNumero: '0',
      razonSocial: receptor.razonSocial || 'Sin Nombre',
      pais: 'PRY', paisDescripcion: 'Paraguay',
      tipoContribuyente: 2, tipoOperacion: 2, email: receptor.email || '',
    }
  } else if (esContribuyente) {
    const [rucRec, dvRec] = (receptor.documento || '').split('-')
    clienteData = {
      contribuyente: true, ruc: rucRec, dv: dvRec || '0',
      razonSocial: receptor.razonSocial || 'Sin Nombre',
      pais: 'PRY', paisDescripcion: 'Paraguay',
      tipoContribuyente: 2, tipoOperacion: 1, email: receptor.email || '', numeroCasa: '0',
    }
  } else {
    clienteData = {
      contribuyente: false,
      documentoTipo: receptor.tipo === 2 ? 1 : 2,
      documentoNumero: receptor.documento || '0',
      razonSocial: receptor.razonSocial || 'Sin Nombre',
      pais: 'PRY', paisDescripcion: 'Paraguay',
      tipoContribuyente: 2, tipoOperacion: 2, email: receptor.email || '',
    }
  }

  const montoTotal  = calcularMontoTotal(payload)
  const montoIva10  = calcularIVA10(payload)
  const montoIva5   = calcularIVA5(payload)
  const montoExento = calcularExento(payload)

  const items = (payload.items || []).map((item, idx) => ({
    codigo: String(idx + 1).padStart(3, '0'),
    descripcion: item.descripcion,
    unidadMedida: 77, cantidad: item.cantidad,
    precioUnitario: item.precioUnitario, cambio: 0,
    descuento: 0, anticipo: 0, porcDescuento: 0,
    descuentoGlobalItem: 0, anticipoGlobalItem: 0,
    ivaTipo: 1, ivaBase: 100, iva: item.tasaIVA,
    lote: '', vencimiento: '', numeroSerie: '',
    numeroPedido: '', numeroSeguimiento: '',
    importacion: {}, dncp: {},
    pais: 'PRY', paisDescripcion: 'Paraguay',
    tolerancia: 0, toleranciaCantidad: 0, toleranciaPorcentaje: 0, cdcAnticipo: '',
  }))

  const data = {
    tipoDocumento:            tipoDoc,
    establecimiento:          estCodigo,
    punto:                    puntoCodigo,
    numero:                   numeroSecuencia.toString().padStart(7, '0'),
    codigoSeguridadAleatorio: codigoSeguridad,
    descripcion:              payload.descripcion || '',
    observacion:              payload.observacion || '',
    fecha:                    fechaEmision.toISOString().substring(0, 19),
    tipoEmision:              1,
    tipoTransaccion:          payload.tipoTransaccion || 1,
    tipoImpuesto:             1,
    moneda:                   payload.moneda || 'PYG',
    descuentoGlobal:          0,
    anticipoGlobal:           0,
    cambio:                   0,
    cliente:                  clienteData,
    factura:                  { presencia: 1 },
    condicion: {
      tipo: 1,
      entregas: [{
        tipo: 1, monto: String(montoTotal),
        moneda: payload.moneda || 'PYG', cambio: 0,
      }],
    },
    items,
  }

  // ── 6. Generar XML ──────────────────────────────────────────────────────────
  let xmlGenerado
  try {
    xmlGenerado = await _xmlgen.generateXMLDE(params, data, { version: 150 })
  } catch (err) {
    return respuestaError('Error generando XML del DE', err.message)
  }

  const cdcMatch = xmlGenerado?.match(/Id="([^"]{44})"/)
  const cdc = cdcMatch ? cdcMatch[1] : null
  if (!cdc) return respuestaError('No se pudo extraer el CDC del XML generado')

  // ── 7. Firmar + QR + Enviar ─────────────────────────────────────────────────
  let xmlFirmado, sifen
  const tmpCert = join('/tmp', `cert_${tenantId}_${Date.now()}.p12`)

  try {
    const certBuffer   = desencriptar(tenant.certificadoEnc)
    const certPassword = tenant.certPassword || ''
    writeFileSync(tmpCert, certBuffer)

    // Ajustar dFecFirma al horario de Paraguay (UTC-3) antes de firmar
    xmlGenerado = xmlGenerado.replace(
      /<dFecFirma>[^<]+<\/dFecFirma>/,
      `<dFecFirma>${ahoraParaguay().toISOString().substring(0, 19)}</dFecFirma>`
    )

    xmlFirmado = await _xmlsign.signXML(xmlGenerado, tmpCert, certPassword, true)

    if (!xmlFirmado?.includes('</Signature>')) {
      throw new Error('La firma digital no se generó correctamente')
    }

    // Agregar QR con idCSC y CSC del tenant
    const env = tenant.ambiente === 'prod' ? 'prod' : 'test'
    xmlFirmado = await _qrgen.generateQR(xmlFirmado, idCSC, tenant.csc, env)
    console.log('XML con QR generado, length:', xmlFirmado?.length)

    // Enviar a SIFEN por lote asíncrono
    sifen = await enviarASIFEN(xmlFirmado, tenant.ambiente, tmpCert, certPassword, cdc)

  } catch (err) {
    return respuestaError('Error firmando, generando QR o enviando el DE', err.message)
  } finally {
    try { unlinkSync(tmpCert) } catch (e) {}
  }

  const estadoFinal = sifen.aprobado ? 'aprobado' : (sifen.pendiente ? 'pendiente' : 'rechazado')

  // ── 8. Persistir ────────────────────────────────────────────────────────────
  const [doc] = await sql`
    INSERT INTO documentos (
      tenant_id, timbrado_id, cdc, tipo_documento, numero, numero_secuencia,
      estado, payload_json, xml_generado, xml_firmado,
      receptor_tipo, receptor_doc, receptor_razon,
      monto_total, monto_iva_10, monto_iva_5, monto_exento,
      referencia_ext, webhook_url
    ) VALUES (
      ${tenantId}, ${timbrado.id}, ${cdc}, ${tipoDoc}, ${numeroFormateado}, ${numeroSecuencia},
      ${estadoFinal}, ${JSON.stringify(payload)}, ${xmlGenerado}, ${xmlFirmado},
      ${receptor.tipo        || null},
      ${receptor.documento   || null},
      ${receptor.razonSocial || null},
      ${montoTotal}, ${montoIva10}, ${montoIva5}, ${montoExento},
      ${payload.referenciaExterna || null},
      ${payload.webhookUrl        || null}
    ) RETURNING *
  `

  // ── 9. Actualizar con respuesta SIFEN ───────────────────────────────────────
  const [docFinal] = await sql`
    UPDATE documentos SET
      xml_aprobado  = ${sifen.xmlRespuesta || null},
      sifen_codigo  = ${sifen.codigo       || null},
      sifen_mensaje = ${sifen.mensaje      || null},
      sifen_env_en  = ${sifen.enviadoEn},
      sifen_resp_en = ${sifen.respondidoEn}
    WHERE id = ${doc.id} RETURNING *
  `

  // ── 10. Log ─────────────────────────────────────────────────────────────────
  await sql`
    INSERT INTO sifen_logs (
      documento_id, tenant_id, accion,
      request_xml, response_xml,
      codigo_resp, mensaje_resp, duracion_ms, exitoso
    ) VALUES (
      ${doc.id}, ${tenantId}, 'envio',
      ${xmlFirmado}, ${sifen.xmlRespuesta || null},
      ${sifen.codigo || null}, ${sifen.mensaje || null},
      ${sifen.duracionMs || 0}, ${sifen.aprobado}
    )
  `

  dispararWebhook(docFinal, sifen.aprobado ? 'de.aprobado' : 'de.rechazado').catch(() => {})
  return respuestaDE(docFinal)
}

export async function cancelarDocumento(tenantId, cdc, motivo = 'Cancelación solicitada por el emisor') {
  await cargarLibrerias()
  const sql = getDb()

  // ── 1. Validaciones ─────────────────────────────────────────────────────────
  const [doc] = await sql`SELECT * FROM documentos WHERE cdc = ${cdc} AND tenant_id = ${tenantId}`
  if (!doc)                      return respuestaError('Documento no encontrado')
  if (doc.estado !== 'aprobado') return respuestaError(`No se puede cancelar un DE en estado: ${doc.estado}`)

  // ── 2. Tenant + certificado ─────────────────────────────────────────────────
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_password,
           csc, id_csc
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)                return respuestaError('Tenant no encontrado')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')

  // ── 3. Generar XML del evento de cancelación ─────────────────────────────────
  const env         = tenant.ambiente === 'prod' ? 'prod' : 'test'
  const idCSC       = tenant.idCsc || '0001'
  // Params del evento — mismo formato que el DE
  const [timbrado] = await sql`
    SELECT t.*, e.codigo AS est_codigo, p.codigo AS punto_codigo
    FROM timbrados t
    JOIN establecimientos e ON e.id = t.establecimiento_id
    JOIN puntos_expedicion p ON p.id = t.punto_id
    WHERE t.id = ${doc.timbradoId}
  `

  const timbradoFechaEvento = timbrado?.vigenciaDesde
    ? (timbrado.vigenciaDesde instanceof Date
        ? timbrado.vigenciaDesde.toISOString().split('T')[0]
        : String(timbrado.vigenciaDesde).split('T')[0])
    : ''

  const params = {
    version:           150,
    ruc:               tenant.ruc,
    razonSocial:       tenant.razonSocial,
    timbradoNumero:    timbrado?.numeroTimbrado || '',
    timbradoFecha:     timbradoFechaEvento,
    tipoContribuyente: 2,
    establecimientos: [{
      codigo:                  timbrado?.estCodigo?.toString().padStart(3,'0') || '001',
      direccion:               '',
      numeroCasa:              '0',
      departamento:            1,
      departamentoDescripcion: 'CAPITAL',
      distrito:                1,
      distritoDescripcion:     'ASUNCION (DISTRITO)',
      ciudad:                  1,
      ciudadDescripcion:       'ASUNCION (DISTRITO)',
      telefono:                '',
      email:                   '',
    }],
  }

  // Estructura exacta según README de la librería
  const dataEvento = {
    cdc,
    motivo,
  }

  let xmlEvento, xmlEventoFirmado
  const tmpCert = join('/tmp', `cert_cancel_${tenantId}_${Date.now()}.p12`)

  try {
    const certBuffer   = desencriptar(tenant.certificadoEnc)
    const certPassword = tenant.certPassword || ''
    writeFileSync(tmpCert, certBuffer)

    // Generar XML del evento — firma: (id, params, data, config)
    xmlEvento = await _xmlgen.generateXMLEventoCancelacion(1, params, dataEvento, { version: 150 })
    console.log('XML Evento cancelacion generado, length:', xmlEvento?.length)

    if (!xmlEvento) throw new Error('No se pudo generar el XML del evento')

    // Firmar el evento
    xmlEventoFirmado = await _xmlsign.signXMLEvento(xmlEvento, tmpCert, certPassword)

    if (!xmlEventoFirmado?.includes('</Signature>')) {
      throw new Error('La firma del evento no se generó correctamente')
    }

    // Enviar el evento a SIFEN usando _setapi.evento
    const r = await _setapi.evento(
      1,
      xmlEventoFirmado,
      env,
      tmpCert,
      certPassword,
      { timeout: config.sifen.timeoutMs }
    )

    console.log('EVENTO CANCELACION RESPONSE:', JSON.stringify(r))

    // Parsear respuesta del evento
    // Estructura real: ns2:rRetEnviEventoDe > ns2:gResProcEVe > ns2:gResProc
    const respEvento   = r?.['ns2:rRetEnviEventoDe'] || r
    const gResProcEVe  = respEvento?.['ns2:gResProcEVe']
    const gResProc     = gResProcEVe?.['ns2:gResProc']
    const codigoEvento = gResProc?.['ns2:dCodRes']
    const mensajeEvento= gResProc?.['ns2:dMsgRes']
    const estRes       = gResProcEVe?.['ns2:dEstRes']
    // 0085 = Aprobado evento, 4003 = ya cancelado (igual lo consideramos ok)
    const aprobado     = estRes === 'Aprobado' || ['0085', '0260', '0422', '0600'].includes(codigoEvento)
                      || codigoEvento === '4003'  // ya cancelado = ya estaba cancelado, aceptar

    console.log(`Evento cancelacion: estado=${estRes} codigo=${codigoEvento} mensaje=${mensajeEvento}`)

    if (!aprobado) {
      return respuestaError(`La SET no aprobo la cancelacion: ${mensajeEvento} (${codigoEvento})`)
    }

  } catch (err) {
    console.error('Error cancelando documento:', err.message)
    return respuestaError('Error enviando cancelación a SIFEN: ' + err.message)
  } finally {
    try { unlinkSync(tmpCert) } catch (e) {}
  }

  // ── 4. Actualizar estado en BD ──────────────────────────────────────────────
  const [docCancelado] = await sql`
    UPDATE documentos
    SET estado = 'cancelado', actualizado_en = now()
    WHERE id = ${doc.id}
    RETURNING *
  `

  dispararWebhook(docCancelado, 'de.cancelado').catch(() => {})
  return respuestaDE(docCancelado)
}


// ── Inutilización de documentos ───────────────────────────────────────────────
export async function inutilizarDocumentos(tenantId, { tipoDocumento, establecimiento, punto, desde, hasta, motivo }) {
  await cargarLibrerias()
  const sql = getDb()

  // ── 1. Tenant + certificado ─────────────────────────────────────────────────
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_password,
           csc, id_csc
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)                return respuestaError('Tenant no encontrado')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')

  // ── 2. Timbrado ─────────────────────────────────────────────────────────────
  const [timbrado] = await sql`
    SELECT t.*, e.codigo AS est_codigo, p.codigo AS punto_codigo
    FROM timbrados t
    JOIN establecimientos e ON e.id = t.establecimiento_id
    JOIN puntos_expedicion p ON p.id = t.punto_id
    WHERE t.tenant_id = ${tenantId}
      AND t.tipo_documento = ${tipoDocumento || 1}
      AND t.activo = true
    ORDER BY t.vigencia_hasta DESC LIMIT 1
  `
  if (!timbrado) return respuestaError('No se encontró timbrado activo para ese tipo de documento')

  const estCodigo   = (establecimiento || timbrado.estCodigo).toString().padStart(3, '0')
  const puntoCodigo = (punto || timbrado.puntoCodigo).toString().padStart(3, '0')

  const timbradoFecha = timbrado.vigenciaDesde instanceof Date
    ? timbrado.vigenciaDesde.toISOString().split('T')[0]
    : String(timbrado.vigenciaDesde).split('T')[0]

  const params = {
    version:           150,
    ruc:               tenant.ruc,
    razonSocial:       tenant.razonSocial,
    timbradoNumero:    timbrado.numeroTimbrado,
    timbradoFecha,
    tipoContribuyente: 2,
    establecimientos: [{
      codigo:                  estCodigo,
      direccion:               '',
      numeroCasa:              '0',
      departamento:            1,
      departamentoDescripcion: 'CAPITAL',
      distrito:                1,
      distritoDescripcion:     'ASUNCION (DISTRITO)',
      ciudad:                  1,
      ciudadDescripcion:       'ASUNCION (DISTRITO)',
      telefono:                '',
      email:                   '',
    }],
  }

  // Estructura según README de la librería para inutilizacion
  const dataEvento = {
    timbrado:        timbrado.numeroTimbrado,
    tipoDocumento:   tipoDocumento || 1,
    establecimiento: estCodigo,
    punto:           puntoCodigo,
    desde:           Number(desde),
    hasta:           Number(hasta),
    motivo:          motivo || 'Documentos no utilizados',
  }

  // ── 3. Generar + firmar + enviar ─────────────────────────────────────────────
  let xmlEvento, xmlEventoFirmado
  const tmpCert = join('/tmp', `cert_inut_${tenantId}_${Date.now()}.p12`)
  const env     = tenant.ambiente === 'prod' ? 'prod' : 'test'

  try {
    const certBuffer   = desencriptar(tenant.certificadoEnc)
    const certPassword = tenant.certPassword || ''
    writeFileSync(tmpCert, certBuffer)

    xmlEvento = await _xmlgen.generateXMLEventoInutilizacion(1, params, dataEvento, { version: 150 })
    console.log('XML Evento inutilizacion generado, length:', xmlEvento?.length)
    if (!xmlEvento) throw new Error('No se pudo generar el XML del evento de inutilizacion')

    xmlEventoFirmado = await _xmlsign.signXMLEvento(xmlEvento, tmpCert, certPassword)
    if (!xmlEventoFirmado?.includes('</Signature>')) {
      throw new Error('La firma del evento no se genero correctamente')
    }

    const r = await _setapi.evento(
      1,
      xmlEventoFirmado,
      env,
      tmpCert,
      certPassword,
      { timeout: config.sifen.timeoutMs }
    )

    console.log('EVENTO INUTILIZACION RESPONSE:', JSON.stringify(r))

    const respEvento2   = r?.['ns2:rRetEnviEventoDe'] || r
    const gResProcEVe2  = respEvento2?.['ns2:gResProcEVe']
    const gResProc2     = gResProcEVe2?.['ns2:gResProc']
    const codigoEvento  = gResProc2?.['ns2:dCodRes']
    const mensajeEvento = gResProc2?.['ns2:dMsgRes']
    const estRes2       = gResProcEVe2?.['ns2:dEstRes']
    const aprobado      = estRes2 === 'Aprobado' || ['0085', '0260', '0422'].includes(codigoEvento)

    console.log(`Evento inutilizacion: estado=${estRes2} codigo=${codigoEvento} mensaje=${mensajeEvento}`)

    if (!aprobado) {
      return respuestaError(`La SET no aprobo la inutilizacion: ${mensajeEvento} (${codigoEvento})`)
    }

  } catch (err) {
    console.error('Error inutilizando documentos:', err.message)
    return respuestaError('Error enviando inutilizacion a SIFEN: ' + err.message)
  } finally {
    try { unlinkSync(tmpCert) } catch (e) {}
  }

  // ── 4. Marcar documentos como inutilizados en BD ─────────────────────────────
  const numeroDesde = Number(desde)
  const numeroHasta = Number(hasta)
  await sql`
    UPDATE documentos
    SET estado = 'inutilizado', actualizado_en = now()
    WHERE tenant_id   = ${tenantId}
      AND tipo_documento = ${tipoDocumento || 1}
      AND numero_secuencia >= ${numeroDesde}
      AND numero_secuencia <= ${numeroHasta}
      AND estado IN ('rechazado', 'pendiente')
  `

  return {
    ok:      true,
    mensaje: `Documentos ${desde} al ${hasta} inutilizados correctamente en la SET`,
    desde:   numeroDesde,
    hasta:   numeroHasta,
  }
}

// ── Enviar a SIFEN por lote asíncrono ─────────────────────────────────────────
async function enviarASIFEN(xmlFirmado, ambiente, certPath, certPassword, cdc = '') {
  const inicio    = Date.now()
  const enviadoEn = new Date()

  // ── MODO DEBUG ────────────────────────────────────────────────────────────
  if (process.env.SKIP_SIFEN === 'true') {
    try {
      mkdirSync('/tmp/preview', { recursive: true })
      const filepath = join('/tmp/preview', `DE_${cdc || Date.now()}.xml`)
      writeFileSync(filepath, xmlFirmado, 'utf8')
      console.log('=== SKIP_SIFEN ACTIVO — XML NO ENVIADO A SIFEN ===')
      console.log(xmlFirmado)
    } catch (e) {
      console.error('Error guardando preview:', e.message)
    }
    return {
      aprobado: false, pendiente: false,
      codigo: 'SKIP',
      mensaje: 'SKIP_SIFEN activo — XML generado sin enviar',
      xmlRespuesta: null, enviadoEn,
      respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  }

  // ── ENVÍO REAL POR LOTE ───────────────────────────────────────────────────
  try {
    const env = ambiente === 'prod' ? 'prod' : 'test'

    const r = await _setapi.recibeLote(
      1,
      [xmlFirmado],
      env,
      certPath,
      certPassword,
      { timeout: config.sifen.timeoutMs }
    )

    console.log('SIFEN LOTE RESPONSE:', JSON.stringify(r))

    // Extraer número de lote y código de respuesta
    const respLote    = r?.['ns2:rRetEnvioLote'] || r?.['ns2:rResEnviLoteDe'] || r
    const codigoLote  = respLote?.['ns2:dCodRes'] || respLote?.['ns2:gResProcLote']?.['ns2:dCodRes']
    const mensajeLote = respLote?.['ns2:dMsgRes'] || respLote?.['ns2:gResProcLote']?.['ns2:dMsgRes']
   const numeroLote = respLote?.['ns2:dProtConsLote'] || respLote?.['ns2:dNumLote']

    console.log('Código:', codigoLote, '| Mensaje:', mensajeLote, '| NumLote:', numeroLote)

    // Código 0300 = Lote recibido OK → consultamos resultado
    if (numeroLote && codigoLote === '0300') {
      console.log(`Lote ${numeroLote} recibido — consultando en 5 segundos...`)
      await esperar(5000)

      const resultado = await consultarLote(numeroLote, env, certPath, certPassword)
      console.log('RESULTADO LOTE:', JSON.stringify(resultado))

      return {
        aprobado:     resultado.aprobado,
        pendiente:    false,
        codigo:       resultado.codigo,
        mensaje:      resultado.mensaje,
        xmlRespuesta: JSON.stringify(r),
        enviadoEn,
        respondidoEn: new Date(),
        duracionMs:   Date.now() - inicio,
      }
    }

    // Lote enviado pero sin número todavía — pendiente
    return {
      aprobado:     false,
      pendiente:    true,
      codigo:       codigoLote || 'LOTE_ENVIADO',
      mensaje:      mensajeLote || 'Lote enviado — resultado pendiente',
      xmlRespuesta: JSON.stringify(r),
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }

  } catch (err) {
    console.error('Error enviando lote:', err.message)
    return {
      aprobado: false, pendiente: false,
      codigo: 'ERR',
      mensaje: `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null, enviadoEn,
      respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  }
}

// ── Consultar resultado del lote con reintentos ───────────────────────────────
async function consultarLote(numeroLote, env, certPath, certPassword, maxIntentos = 5) {
  // 0361 = en procesamiento, reintentamos hasta maxIntentos veces cada 5s
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      const r = await _setapi.consultaLote(
        1, numeroLote, env, certPath, certPassword,
        { timeout: 30000 }
      )

      console.log(`CONSULTA LOTE (intento ${intento}):`, JSON.stringify(r))

      const respLote   = r?.['ns2:rResEnviConsLoteDe'] || r
      const codigoLot  = respLote?.['ns2:dCodResLot']
      const mensajeLot = respLote?.['ns2:dMsgResLot']
      const gResProc   = respLote?.['ns2:gResProcLote']?.['ns2:gResProc']
      const primerResp = Array.isArray(gResProc) ? gResProc[0] : gResProc

      const codigo   = primerResp?.['ns2:dCodRes'] || codigoLot
      const mensaje  = primerResp?.['ns2:dMsgRes'] || mensajeLot
      const estRes   = respLote?.['ns2:gResProcLote']?.['ns2:dEstRes']
      const aprobado = estRes === 'Aprobado' || ['0260', '0422'].includes(codigo)

      // 0361 = todavía procesando — reintentamos
      if (codigoLot === '0361' && intento < maxIntentos) {
        console.log(`Lote ${numeroLote} aun en procesamiento — reintentando en 5s... (${intento}/${maxIntentos})`)
        await esperar(5000)
        continue
      }

      return { aprobado, codigo, mensaje }

    } catch (err) {
      console.error(`Error consultando lote (intento ${intento}):`, err.message)
      if (intento === maxIntentos) {
        return { aprobado: false, codigo: 'ERR_CONSULTA', mensaje: `Error: ${err.message}` }
      }
      await esperar(3000)
    }
  }
  return { aprobado: false, codigo: 'TIMEOUT', mensaje: 'La SET no respondio a tiempo' }
}
// ── Cálculos ──────────────────────────────────────────────────────────────────
const sum = (items, fn) => items.reduce((s, i) => s + (fn(i) || 0), 0)
function calcularMontoTotal(p) { return p.montoTotal  ?? sum(p.items || [], i => i.precioTotal) }
function calcularIVA10(p)      { return p.montoIVA10  ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)       { return p.montoIVA5   ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p)     { return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
