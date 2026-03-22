// src/modules/sifen/motor.js
import { getDb } from '../../db/connection.js'
import { desencriptar } from '../../shared/crypto/index.js'
import { config } from '../../config/index.js'
import { dispararWebhook } from './webhooks.js'
import { respuestaDE, respuestaError } from './respuestas.js'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

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
  } catch (e) {
    throw new Error('Error cargando librerías SIFEN: ' + e.message)
  }
}

export async function procesarDocumento(tenantId, payload) {
  await cargarLibrerias()
  const sql = getDb()

  // ── 1. Tenant ───────────────────────────────────────────────────────────────
  const [tenant] = await sql`
    SELECT id, ruc, razon_social, ambiente, certificado_enc, cert_alias,
           codigo_seguridad, cert_password
    FROM tenants WHERE id = ${tenantId} AND activo = true
  `
  if (!tenant)               return respuestaError('Tenant no encontrado o inactivo')
  if (!tenant.certificadoEnc) return respuestaError('El tenant no tiene certificado digital cargado')

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

  // ── 4. Params (datos estáticos del emisor para xmlgen) ──────────────────────
  const timbradoFecha = new Date(timbrado.vigenciaDesde).toISOString().split('T')[0]
  const depCodigo = timbrado.departamentoCodigo || 11

  const params = {
    version:           150,
    ruc:               tenant.ruc,
    razonSocial:       tenant.razonSocial,
    nombreFantasia:    tenant.razonSocial,
    actividadesEconomicas: [{ codigo: '82999', descripcion: 'Servicios' }],
    timbradoNumero:    timbrado.numeroTimbrado,
    timbradoFecha,
    tipoContribuyente: 2,
    tipoRegimen:       8,
   establecimientos: [{
  codigo:                  estCodigo,
  direccion:               'CAPITAN FIGARI E/MANUEL DOMINGUEZ Y PETTIROSSI',
  numeroCasa:              '0',
  departamento:            11,
  departamentoDescripcion: 'ALTO PARANA',
  distrito:                145,
  distritoDescripcion:     'CIUDAD DEL ESTE',
  ciudad:                  3432,
  ciudadDescripcion:       'PUERTO PTE.STROESSNER (MUNIC)',
  telefono:                '0981818995',
  email:                   'jchaparrosaucedo@gmail.com',
  denominacion:            'Casa Central',
}],
  }

  // ── 5. Data (datos variables del documento para xmlgen) ─────────────────────
  const receptor = payload.receptor || {}
  const codigoSeguridad = (tenant.codigoSeguridad || '000000000').toString().padStart(9, '0').substring(0, 9)
  const fechaEmision = payload.fecha ? new Date(payload.fecha) : new Date()

  const esContribuyente = receptor.tipo === 1
  const esInnominado    = receptor.tipo === 4 || !receptor.tipo

  const cliente = {
    contribuyente:     esContribuyente,
    ruc:               esContribuyente ? receptor.documento : undefined,
    documentoTipo:     esInnominado ? 5 :
                       receptor.tipo === 2 ? 1 :
                       receptor.tipo === 3 ? 2 : undefined,
    documentoNumero:   esInnominado ? '0' : (receptor.documento || '0'),
    razonSocial:       receptor.razonSocial || 'Sin Nombre',
    pais:              receptor.pais || 'PRY',
    paisDescripcion:   'Paraguay',
    tipoContribuyente: esContribuyente ? 1 : 2,
    tipoOperacion:     esContribuyente ? 1 : 2,
    email:             receptor.email || '',
  }

  const items = (payload.items || []).map((item, idx) => ({
    codigo:               String(idx + 1),
    descripcion:          item.descripcion,
    unidadMedida:         77,
    cantidad:             item.cantidad,
    precioUnitario:       item.precioUnitario,
    cambio:               0,
    descuento:            0,
    anticipo:             0,
    porcDescuento:        0,
    descuentoGlobalItem:  0,
    anticipoGlobalItem:   0,
    ivaTipo:              1,
    ivaBase:              100,
    iva:                  item.tasaIVA,
    lote:                 '',
    vencimiento:          '',
    numeroSerie:          '',
    numeroPedido:         '',
    numeroSeguimiento:    '',
    importacion:          {},
    dncp:                 {},
    pais:                 'PRY',
    paisDescripcion:      'Paraguay',
    tolerancia:           0,
    toleranciaCantidad:   0,
    toleranciaPorcentaje: 0,
    cdcAnticipo:          '',
  }))

  const condicion = {
    tipo: 1,
    entregas: [{
      tipo:   1,
      monto:  String(calcularMontoTotal(payload)),
      moneda: payload.moneda || 'PYG',
      cambio: 0,
    }],
  }

  const data = {
    tipoDocumento:            tipoDoc,
    establecimiento:          estCodigo,
    punto:                    puntoCodigo,
    numero:                   numeroSecuencia.toString().padStart(7, '0'),
    codigoSeguridadAleatorio: codigoSeguridad,
    descripcion:              payload.descripcion || 'Factura',
    observacion:              payload.observacion || '',
    fecha:                    fechaEmision.toISOString().substring(0, 19),
    tipoEmision:              1,
    tipoTransaccion:          payload.tipoTransaccion || 1,
    tipoImpuesto:             1,
    moneda:                   payload.moneda || 'PYG',
    condicionAnticipo:        1,
    condicionTipoCambio:      1,
    descuentoGlobal:          0,
    anticipoGlobal:           0,
    cambio:                   0,
    cliente,
    factura: { presencia: 1 },
    condicion,
    items,
    // NO pasamos cdc — xmlgen lo genera internamente
  }

  // ── 6. Generar XML ──────────────────────────────────────────────────────────
  let xmlGenerado
  try {
    xmlGenerado = await _xmlgen.generateXMLDE(params, data, { version: 150 })

    // Extraer CDC real del XML generado por la librería
  } catch (err) {
    return respuestaError('Error generando XML del DE', err.message)
  }

  // Extraer CDC del atributo Id del XML
  const cdcMatch = xmlGenerado?.match(/Id="([^"]{44})"/)
  const cdc = cdcMatch ? cdcMatch[1] : null
  if (!cdc) return respuestaError('No se pudo extraer el CDC del XML generado')

  // ── 7. Firmar XML y enviar a SIFEN ──────────────────────────────────────────
  let xmlFirmado
  let sifen
  const tmpCert = join('/tmp', `cert_${tenantId}_${Date.now()}.p12`)
  try {
    const certBuffer   = desencriptar(tenant.certificadoEnc)
    const certPassword = tenant.certPassword || '12345678'
    writeFileSync(tmpCert, certBuffer)

    xmlFirmado = await _xmlsign.signXML(xmlGenerado, tmpCert, certPassword, true)
    sifen      = await enviarASIFEN(xmlFirmado, tenant.ambiente, tmpCert, certPassword)

  } catch (err) {
    return respuestaError('Error firmando o enviando el DE', err.message)
  } finally {
    try { unlinkSync(tmpCert) } catch (e) {}
  }

  const estadoFinal = sifen.aprobado ? 'aprobado' : 'rechazado'

  // ── 8. Persistir ────────────────────────────────────────────────────────────
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

async function enviarASIFEN(xmlFirmado, ambiente, certPath, certPassword) {
  const inicio    = Date.now()
  const enviadoEn = new Date()
  try {
    const env = ambiente === 'prod' ? 'prod' : 'test'
    const r = await _setapi.recibe(
  1,
  xmlFirmado,
  env,
  certPath,
  certPassword,
  { timeout: config.sifen.timeoutMs, debug: true }
)
    console.log('SIFEN RESPONSE:', JSON.stringify(r))

    const resp     = r?.['ns2:rRetEnviDe']?.['ns2:rProtDe']?.['ns2:gResProc']
    const aprobado = ['0260', '0422'].includes(resp?.['ns2:dCodRes'])
    return {
      aprobado,
      codigo:       resp?.['ns2:dCodRes'] || null,
      mensaje:      resp?.['ns2:dMsgRes'] || null,
      xmlRespuesta: JSON.stringify(r)     || null,
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }
  } catch (err) {
    return {
      aprobado:     false,
      codigo:       'ERR',
      mensaje:      `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null,
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }
  }
}

const sum = (items, fn) => items.reduce((s, i) => s + (fn(i) || 0), 0)
function calcularMontoTotal(p) { return p.montoTotal  ?? sum(p.items || [], i => i.precioTotal) }
function calcularIVA10(p)      { return p.montoIVA10  ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)       { return p.montoIVA5   ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p)     { return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
