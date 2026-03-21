// src/modules/sifen/motor.js — Motor NODO con respuestas estandarizadas + webhooks
import { getDb } from '../../db/connection.js'
import { desencriptar } from '../../shared/crypto/index.js'
import { generarCDC } from '../../shared/utils/cdc.js'
import { config } from '../../config/index.js'
import { dispararWebhook } from './webhooks.js'
import { respuestaDE, respuestaError } from './respuestas.js'

let xmlgen, xmlsign, setapi

async function cargarLibrerias() {
  if (!xmlgen) {
    try {
      xmlgen  = (await import('facturacionelectronicapy-xmlgen')).default
      xmlsign = (await import('facturacionelectronicapy-xmlsign')).default
      setapi  = (await import('facturacionelectronicapy-setapi')).default
    } catch (e) {
      throw new Error('Librerías SIFEN no instaladas.\n' + e.message)
    }
  }
}

export async function procesarDocumento(tenantId, payload) {
  await cargarLibrerias()
  const sql = getDb()

  // 1. Tenant
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_alias, codigo_seguridad
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)             return respuestaError('Tenant no encontrado o inactivo')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')

  // 2. Timbrado activo
  const tipoDoc = payload.tipoDocumento || 1
  const [timbrado] = await sql`
    SELECT t.*, e.codigo AS est_codigo, p.codigo AS punto_codigo
    FROM timbrados t
    JOIN establecimientos e ON e.id = t.establecimiento_id
    JOIN puntos_expedicion p ON p.id = t.punto_id
    WHERE t.tenant_id = ${tenantId} AND t.tipo_documento = ${tipoDoc}
      AND t.activo = true AND t.vigencia_desde <= CURRENT_DATE
      AND t.vigencia_hasta >= CURRENT_DATE AND t.numero_actual <= t.numero_max
    ORDER BY t.vigencia_hasta DESC LIMIT 1
  `
  if (!timbrado) return respuestaError(`Sin timbrado activo para tipo de documento ${tipoDoc}`)

  // 3. Número secuencial atómico
  const [{ numeroActual }] = await sql`
    UPDATE timbrados SET numero_actual = numero_actual + 1
    WHERE id = ${timbrado.id} RETURNING numero_actual - 1 AS numero_actual
  `
  const numeroSecuencia  = Number(numeroActual)
  const numeroFormateado = [
    timbrado.estCodigo.padStart(3,'0'),
    timbrado.puntoCodigo.padStart(3,'0'),
    numeroSecuencia.toString().padStart(7,'0'),
  ].join('-')

  // 4. CDC
  const [rucBase, dvRuc] = tenant.ruc.split('-')
  const cdc = generarCDC({
    tipoDE: tipoDoc, rucEmisor: rucBase, dvEmisor: dvRuc || '0',
    establecimiento: timbrado.estCodigo, puntoExpedicion: timbrado.puntoCodigo,
    numero: numeroSecuencia, tipoTransaccion: payload.tipoTransaccion || 1,
    numeroTimbrado: timbrado.numeroTimbrado,
    fechaEmision: payload.fecha ? new Date(payload.fecha) : new Date(),
    ambiente: tenant.ambiente === 'prod' ? 1 : 2,
  })

  // 5. Generar XML
  let xmlGenerado
  try {
    xmlGenerado = await xmlgen.generateXMLDE({
      ...payload, cdc,
      timbrado: timbrado.numeroTimbrado,
      establecimiento: timbrado.estCodigo,
      punto: timbrado.puntoCodigo,
      numero: numeroSecuencia,
      codigoSeguridadAleatorio: tenant.codigoSeguridad || '000000000',
      emisor: { ruc: tenant.ruc, razonSocial: tenant.razonSocial, ...(payload.emisor||{}) },
    }, { version: 150, fechaFirmaDigital: new Date().toISOString() })
  } catch (err) {
    return respuestaError('Error generando XML del DE', err.message)
  }

  // 6. Firmar XML
  let xmlFirmado
  try {
    const certBuffer = desencriptar(tenant.certificadoEnc)
    xmlFirmado = await xmlsign.signXML(xmlGenerado, certBuffer, tenant.certAlias || '', '')
  } catch (err) {
    return respuestaError('Error firmando el XML con el certificado digital', err.message)
  }

  // 7. Persistir estado "firmado"
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
      ${payload.receptor?.tipo||null}, ${payload.receptor?.documento||null}, ${payload.receptor?.razonSocial||null},
      ${calcularMontoTotal(payload)}, ${calcularIVA10(payload)}, ${calcularIVA5(payload)}, ${calcularExento(payload)},
      ${payload.referenciaExterna||null}, ${payload.webhookUrl||null}
    ) RETURNING *
  `

  // 8. Enviar a SIFEN
  const sifen = await enviarASIFEN(xmlFirmado, tenant.ambiente)
  const estadoFinal = sifen.aprobado ? 'aprobado' : 'rechazado'

  // 9. Actualizar estado final
  const [docFinal] = await sql`
    UPDATE documentos SET
      estado = ${estadoFinal}, xml_aprobado = ${sifen.xmlRespuesta||null},
      sifen_codigo = ${sifen.codigo||null}, sifen_mensaje = ${sifen.mensaje||null},
      sifen_env_en = ${sifen.enviadoEn}, sifen_resp_en = ${sifen.respondidoEn}
    WHERE id = ${doc.id} RETURNING *
  `

  // Log
  await sql`
    INSERT INTO sifen_logs (documento_id, tenant_id, accion, request_xml, response_xml,
      codigo_resp, mensaje_resp, duracion_ms, exitoso)
    VALUES (${doc.id}, ${tenantId}, 'envio', ${xmlFirmado}, ${sifen.xmlRespuesta||null},
      ${sifen.codigo||null}, ${sifen.mensaje||null}, ${sifen.duracionMs||0}, ${sifen.aprobado})
  `

  // 10. Webhook async al ERP (no bloquea)
  dispararWebhook(docFinal, sifen.aprobado ? 'de.aprobado' : 'de.rechazado').catch(()=>{})

  // 11. Respuesta estandarizada al ERP
  return respuestaDE(docFinal)
}

export async function cancelarDocumento(tenantId, cdc) {
  const sql = getDb()
  const [doc] = await sql`SELECT * FROM documentos WHERE cdc=${cdc} AND tenant_id=${tenantId}`
  if (!doc) return respuestaError('Documento no encontrado')
  if (doc.estado !== 'aprobado') return respuestaError(`No se puede cancelar un DE en estado: ${doc.estado}`)

  const [docCancelado] = await sql`
    UPDATE documentos SET estado='cancelado', actualizado_en=now()
    WHERE id=${doc.id} RETURNING *
  `
  dispararWebhook(docCancelado, 'de.cancelado').catch(()=>{})
  return respuestaDE(docCancelado)
}

async function enviarASIFEN(xmlFirmado, ambiente) {
  const inicio = Date.now()
  const enviadoEn = new Date()
  try {
    const r = await setapi.recibeLote(xmlFirmado, ambiente === 'prod' ? 'prod' : 'test',
      { timeout: config.sifen.timeoutMs })
    const aprobado = ['0260','0422'].includes(r?.dRespuesta?.dCodRes)
    return { aprobado, codigo: r?.dRespuesta?.dCodRes, mensaje: r?.dRespuesta?.dMsgRes,
      xmlRespuesta: r?.xmlRespuesta, enviadoEn, respondidoEn: new Date(), duracionMs: Date.now()-inicio }
  } catch (err) {
    return { aprobado: false, codigo: 'ERR', mensaje: `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null, enviadoEn, respondidoEn: new Date(), duracionMs: Date.now()-inicio }
  }
}

const sum = (items, fn) => items.reduce((s,i) => s+(fn(i)||0), 0)
function calcularMontoTotal(p) { return p.montoTotal ?? sum(p.items||[], i=>i.precioTotal) }
function calcularIVA10(p) { return p.montoIVA10 ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)  { return p.montoIVA5  ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p){ return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
