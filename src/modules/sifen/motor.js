// src/modules/sifen/motor.js
import { getDb } from '../../db/connection.js'
import { desencriptar } from '../../shared/crypto/index.js'
import { generarCDC } from '../../shared/utils/cdc.js'
import { config } from '../../config/index.js'
import { dispararWebhook } from './webhooks.js'
import { respuestaDE, respuestaError } from './respuestas.js'

let _xmlgen, _xmlsign, _setapi

async function cargarLibrerias() {
  if (_xmlgen) return

  try {
    const modXmlgen  = await import('facturacionelectronicapy-xmlgen')
    const modXmlsign = await import('facturacionelectronicapy-xmlsign')
    const modSetapi  = await import('facturacionelectronicapy-setapi')

    _xmlgen  = modXmlgen.default?.default  || modXmlgen.default  || modXmlgen
    _xmlsign = modXmlsign.default?.default || modXmlsign.default || modXmlsign
    _setapi  = modSetapi.default?.default  || modSetapi.default  || modSetapi

    if (typeof _xmlgen.generateXMLDE !== 'function') {
      if (typeof modXmlgen.generateXMLDE === 'function') {
        _xmlgen = modXmlgen
      } else {
        throw new Error(`generateXMLDE no encontrado. Keys: ${Object.keys(_xmlgen).join(', ')}`)
      }
    }
    if (typeof _xmlsign.signXML !== 'function') {
      if (typeof modXmlsign.signXML === 'function') _xmlsign = modXmlsign
    }
    if (typeof _setapi.recibeLote !== 'function') {
      if (typeof modSetapi.recibeLote === 'function') _setapi = modSetapi
    }

  } catch (e) {
    throw new Error('Error cargando librerías SIFEN: ' + e.message)
  }
}

export async function procesarDocumento(tenantId, payload) {
  await cargarLibrerias()
  const sql = getDb()

  // ── 1. Tenant ───────────────────────────────────────────────────────────────
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_alias, codigo_seguridad
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)               return respuestaError('Tenant no encontrado o inactivo')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')

  // ── 2. Timbrado activo ──────────────────────────────────────────────────────
  const tipoDoc = payload.tipoDocumento || 1
  const [timbrado] = await sql`
    SELECT t.*, e.codigo AS est_codigo, p.codigo AS punto_codigo
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

  // ── 4. CDC ──────────────────────────────────────────────────────────────────
  const [rucBase, dvRuc] = tenant.ruc.split('-')
  const cdc = generarCDC({
    tipoDE:          tipoDoc,
    rucEmisor:       rucBase,
    dvEmisor:        dvRuc || '0',
    establecimiento: estCodigo,
    puntoExpedicion: puntoCodigo,
    numero:          numeroSecuencia,
    tipoTransaccion: payload.tipoTransaccion || 1,
    numeroTimbrado:  timbrado.numeroTimbrado,
    fechaEmision:    payload.fecha ? new Date(payload.fecha) : new Date(),
    ambiente:        tenant.ambiente === 'prod' ? 1 : 2,
  })

  // ── 5. Generar XML ──────────────────────────────────────────────────────────
  const codigoSeguridad = (tenant.codigoSeguridad || '000000000').toString().padStart(9, '0').substring(0, 9)

  const xmlgenPayload = {
    ...payload,
    tipoDocumento:            tipoDoc,
    cdc,
    timbrado:                 timbrado.numeroTimbrado,
    establecimiento:          estCodigo,
    punto:                    puntoCodigo,
    numero:                   numeroSecuencia,
    codigoSeguridadAleatorio: codigoSeguridad,
    emisor: {
      ruc:         tenant.ruc,
      razonSocial: tenant.razonSocial,
      ...(payload.emisor || {}),
    },
  }

  // Log diagnóstico
  console.log('XMLGEN PAYLOAD tipoDocumento:', xmlgenPayload.tipoDocumento)
  console.log('XMLGEN PAYLOAD emisor:', JSON.stringify(xmlgenPayload.emisor))
  console.log('XMLGEN PAYLOAD receptor:', JSON.stringify(xmlgenPayload.receptor))
  console.log('XMLGEN PAYLOAD items count:', xmlgenPayload.items?.length)

  let xmlGenerado
  try {
    xmlGenerado = await _xmlgen.generateXMLDE(
      xmlgenPayload,
      { version: 150, fechaFirmaDigital: new Date().toISOString() }
    )
  } catch (err) {
    return respuestaError('Error generando XML del DE', err.message)
  }

  // ── 6. Firmar XML ───────────────────────────────────────────────────────────
  let xmlFirmado
  try {
    const certBuffer = desencriptar(tenant.certificadoEnc)
    xmlFirmado = await _xmlsign.signXML(xmlGenerado, certBuffer, tenant.certAlias || '', '')
  } catch (err) {
    return respuestaError('Error firmando el XML con el certificado digital', err.message)
  }

  // ── 7. Persistir estado "firmado" ───────────────────────────────────────────
  const montoTotal  = calcularMontoTotal(payload)
  const montoIva10  = calcularIVA10(payload)
  const montoIva5   = calcularIVA5(payload)
  const montoExento = calcularExento(payload)

  const [doc] = await sql`
    INSERT INTO documentos (
      tenant_id, timbrado_id, cdc, tipo_documento, numero, numero_secuencia,
      estado, payload_json, xml_generado, xml_firmado,
      receptor_tipo, receptor_doc, receptor_razon,
      monto_total, monto_iva_10, monto_iva_5, monto_exento,
      referencia_ext, webhook_url
    ) VALUES (
      ${tenantId}, ${timbrado.id}, ${cdc}, ${tipoDoc}, ${numeroFormateado}, ${numeroSecuencia},
      'firmado', ${JSON.stringify(payload)}, ${xmlGenerado}, ${xmlFirmado},
      ${payload.receptor?.tipo        || null},
      ${payload.receptor?.documento   || null},
      ${payload.receptor?.razonSocial || null},
      ${montoTotal}, ${montoIva10}, ${montoIva5}, ${montoExento},
      ${payload.referenciaExterna || null},
      ${payload.webhookUrl        || null}
    ) RETURNING *
  `

  // ── 8. Enviar a SIFEN ───────────────────────────────────────────────────────
  const sifen       = await enviarASIFEN(xmlFirmado, tenant.ambiente)
  const estadoFinal = sifen.aprobado ? 'aprobado' : 'rechazado'

  // ── 9. Actualizar estado final ──────────────────────────────────────────────
  const [docFinal] = await sql`
    UPDATE documentos SET
      estado        = ${estadoFinal},
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

export async function cancelarDocumento(tenantId, cdc) {
  const sql = getDb()
  const [doc] = await sql`SELECT * FROM documentos WHERE cdc = ${cdc} AND tenant_id = ${tenantId}`
  if (!doc) return respuestaError('Documento no encontrado')
  if (doc.estado !== 'aprobado') return respuestaError(`No se puede cancelar un DE en estado: ${doc.estado}`)
  const [docCancelado] = await sql`
    UPDATE documentos SET estado = 'cancelado', actualizado_en = now() WHERE id = ${doc.id} RETURNING *
  `
  dispararWebhook(docCancelado, 'de.cancelado').catch(() => {})
  return respuestaDE(docCancelado)
}

async function enviarASIFEN(xmlFirmado, ambiente) {
  const inicio    = Date.now()
  const enviadoEn = new Date()
  try {
    const r = await _setapi.recibeLote(
      xmlFirmado,
      ambiente === 'prod' ? 'prod' : 'test',
      { timeout: config.sifen.timeoutMs }
    )
    const aprobado = ['0260', '0422'].includes(r?.dRespuesta?.dCodRes)
    return {
      aprobado, codigo: r?.dRespuesta?.dCodRes, mensaje: r?.dRespuesta?.dMsgRes,
      xmlRespuesta: r?.xmlRespuesta || null,
      enviadoEn, respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  } catch (err) {
    return {
      aprobado: false, codigo: 'ERR',
      mensaje: `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null,
      enviadoEn, respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  }
}

const sum = (items, fn) => items.reduce((s, i) => s + (fn(i) || 0), 0)
function calcularMontoTotal(p) { return p.montoTotal  ?? sum(p.items || [], i => i.precioTotal) }
function calcularIVA10(p)      { return p.montoIVA10  ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)       { return p.montoIVA5   ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p)     { return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
