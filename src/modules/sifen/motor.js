// src/modules/sifen/motor.js
import { getDb } from '../../db/connection.js'
import { desencriptar } from '../../shared/crypto/index.js'
import { config } from '../../config/index.js'
import { dispararWebhook } from './webhooks.js'
import { respuestaDE, respuestaError } from './respuestas.js'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import https from 'https'
import axios from 'axios'
import xml2js from 'xml2js'

let _xmlgen, _xmlsign

async function cargarLibrerias() {
  if (_xmlgen) return
  try {
    const modXmlgen  = await import('facturacionelectronicapy-xmlgen')
    const modXmlsign = await import('facturacionelectronicapy-xmlsign')
    _xmlgen  = modXmlgen.default?.default  || modXmlgen.default  || modXmlgen
    _xmlsign = modXmlsign.default?.default || modXmlsign.default || modXmlsign
  } catch (e) {
    throw new Error('Error cargando librerías SIFEN: ' + e.message)
  }
}

// Extrae cert PEM y key PEM de un archivo .p12 usando node-forge
function extraerCertKey(certPath, password) {
  const forge = require('node-forge')
  const p12Der = readFileSync(certPath).toString('binary')
  const p12Asn1 = forge.asn1.fromDer(p12Der)
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)

  let certPem = ''
  let keyPem  = ''

  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.certBag) {
        certPem = forge.pki.certificateToPem(safeBag.cert)
      }
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag ||
          safeBag.type === forge.pki.oids.keyBag) {
        keyPem = forge.pki.privateKeyToPem(safeBag.key)
      }
    }
  }
  return { certPem, keyPem }
}

function generarUrlQR({ cdc, fechaEmision, rucReceptor, montoTotal, montoIVA, cantItems, digestValue, idCSC, codigoSeg }) {
  const dFeEmiDE  = Buffer.from(fechaEmision).toString('hex')
  const dDigVal   = Buffer.from(digestValue).toString('hex')
  const strHash   = `${cdc}${dFeEmiDE}${rucReceptor}${montoTotal}${montoIVA}${cantItems}${dDigVal}${idCSC}${codigoSeg}`
  const cHashQR   = createHash('sha256').update(strHash).digest('hex')

  const p = new URLSearchParams({
    nVersion:    '150',
    Id:          cdc,
    dFeEmiDE,
    dRucRec:     rucReceptor || '0',
    dTotGralOpe: String(montoTotal),
    dTotIVA:     String(montoIVA),
    cItems:      String(cantItems),
    DigestValue: dDigVal,
    IdCSC:       idCSC || '0001',
    cHashQR,
  })
  return `https://ekuatia.set.gov.py/consultas/qr?${p.toString()}`
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
  if (!tenant)                return respuestaError('Tenant no encontrado o inactivo')
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
  const fechaEmision     = payload.fecha ? new Date(payload.fecha) : new Date()
  const codigoSeguridad  = (tenant.codigoSeguridad || '123456789').toString().padStart(9, '0').substring(0, 9)

  // ── 4. Params ───────────────────────────────────────────────────────────────
  const timbradoFecha = new Date(timbrado.vigenciaDesde).toISOString().split('T')[0]

  const params = {
    version:           150,
    ruc:               tenant.ruc,
    razonSocial:       tenant.razonSocial,
    nombreFantasia:    tenant.razonSocial,
    actividadesEconomicas: [
      { codigo: '82999', descripcion: 'OTRAS ACTIVIDADES DE SERVICIOS DE APOYO A EMPRESAS N.C.P.' },
      { codigo: '47190', descripcion: 'COMERCIO AL POR MENOR DE OTROS PRODUCTOS EN COMERCIOS NO ESPECIALIZADOS' },
      { codigo: '96011', descripcion: 'SERVICIOS DE LAVADERIAS DE ROPA' },
      { codigo: '56101', descripcion: 'RESTAURANTES Y PARRILLADAS' },
      { codigo: '74909', descripcion: 'OTRAS ACTIVIDADES PROFESIONALES, CIENTIFICAS Y TECNICAS N.C.P.' },
    ],
    timbradoNumero:    timbrado.numeroTimbrado,
    timbradoFecha,
    tipoContribuyente: 2,
    tipoRegimen:       8,
    establecimientos: [{
      codigo:                  estCodigo,
      direccion:               'CAPITAN FIGARI E/MANUEL DOMINGUEZ Y PETTIROSSI',
      numeroCasa:              '0',
      departamento:            1,
      departamentoDescripcion: 'CAPITAL',
      distrito:                1,
      distritoDescripcion:     'ASUNCION (DISTRITO)',
      ciudad:                  1,
      ciudadDescripcion:       'ASUNCION (DISTRITO)',
      telefono:                '0981818995',
      email:                   'jchaparrosaucedo@gmail.com',
      denominacion:            'Sucursal 1',
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
  const montoIVA    = montoIva10 + montoIva5

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

  // ── 7. Firmar y enviar ──────────────────────────────────────────────────────
  let xmlFirmado, sifen
  const tmpCert = join('/tmp', `cert_${tenantId}_${Date.now()}.p12`)

  try {
    const certBuffer   = desencriptar(tenant.certificadoEnc)
    const certPassword = tenant.certPassword || '12345678'
    writeFileSync(tmpCert, certBuffer)

    // Firmar con Node.js
    xmlFirmado = await _xmlsign.signXML(xmlGenerado, tmpCert, certPassword, true)

    if (!xmlFirmado?.includes('</Signature>')) {
      throw new Error('La firma digital no se generó correctamente')
    }

    // Extraer DigestValue para el QR
    const digestMatch = xmlFirmado.match(/<DigestValue>([^<]+)<\/DigestValue>/)
    const digestValue = digestMatch ? digestMatch[1] : ''

    // Construir URL QR
    const rucRec   = esContribuyente ? (receptor.documento || '').split('-')[0] : '0'
    const urlQR    = generarUrlQR({
      cdc, fechaEmision: fechaEmision.toISOString().substring(0, 19),
      rucReceptor: rucRec, montoTotal, montoIVA,
      cantItems: items.length, digestValue,
      idCSC: '0001', codigoSeg: codigoSeguridad,
    })
    const urlQREsc = urlQR.replace(/&/g, '&amp;')
    const gCamFuFD = `<gCamFuFD><dCarQR>${urlQREsc}</dCarQR></gCamFuFD>`

    // Insertar gCamFuFD después de </Signature>
    xmlFirmado = xmlFirmado.replace(/<\/Signature>(\s*)<\/rDE>/, `</Signature>${gCamFuFD}</rDE>`)

    // Enviar a SIFEN con SOAP manual
    sifen = await enviarASIFEN(xmlFirmado, tenant.ambiente, tmpCert, certPassword)

  } catch (err) {
    return respuestaError('Error firmando o enviando el DE', err.message)
  } finally {
    try { unlinkSync(tmpCert) } catch (e) {}
  }

  const estadoFinal = sifen.aprobado ? 'aprobado' : 'rechazado'

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

// ── SOAP manual — sin pasar por normalizeXML de setapi ───────────────────────
async function enviarASIFEN(xmlFirmado, ambiente, certPath, certPassword) {
  const inicio    = Date.now()
  const enviadoEn = new Date()
  try {
    const env = ambiente === 'prod' ? 'prod' : 'test'
    const url = env === 'prod'
      ? 'https://sifen.set.gov.py/de/ws/sync/recibe.wsdl'
      : 'https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl'

    // Extraer cert y key del .p12 usando node-forge
    const { certPem, keyPem } = extraerCertKey(certPath, certPassword)

    const httpsAgent = new https.Agent({
      cert: certPem,
      key:  keyPem,
    })

    // Quitar declaración XML (<?xml...?>) — SIFEN la rechaza dentro del SOAP
    const xmlSinDecl = xmlFirmado.replace(/^<\?xml[^?]*\?>\s*/, '')

    // Construir SOAP envelope — sin normalizar, exactamente como debe ir
    const soap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">',
      '<env:Header/>',
      '<env:Body>',
      '<rEnviDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">',
      '<dId>1</dId>',
      `<xDE>${xmlSinDecl}</xDE>`,
      '</rEnviDe>',
      '</env:Body>',
      '</env:Envelope>',
    ].join('')

    console.log('Enviando SOAP, length:', soap.length)

    const respuesta = await axios.post(url, soap, {
      headers: {
        'User-Agent':   'facturaSend',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      httpsAgent,
      timeout: config.sifen.timeoutMs,
    })

    const parsed = await xml2js.parseStringPromise(respuesta.data, { explicitArray: false })
    console.log('SIFEN RESPONSE:', JSON.stringify(parsed))

    const body       = parsed?.['env:Envelope']?.['env:Body']
    const resp       = body?.['ns2:rRetEnviDe']?.['ns2:rProtDe']?.['ns2:gResProc']
    const primerResp = Array.isArray(resp) ? resp[0] : resp
    const aprobado   = ['0260', '0422'].includes(primerResp?.['ns2:dCodRes'])

    const mensaje = Array.isArray(resp)
      ? resp.map(r => r?.['ns2:dMsgRes']).filter(Boolean).join(' | ')
      : primerResp?.['ns2:dMsgRes'] || null

    return {
      aprobado,
      codigo:       primerResp?.['ns2:dCodRes'] || null,
      mensaje,
      xmlRespuesta: JSON.stringify(parsed) || null,
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }

  } catch (err) {
    // Si SIFEN devuelve error HTTP, intentar parsear la respuesta
    if (err.response?.data) {
      console.log('SIFEN HTTP ERROR:', err.response.status, String(err.response.data).substring(0, 500))
      try {
        const parsed = await xml2js.parseStringPromise(err.response.data, { explicitArray: false })
        const body       = parsed?.['env:Envelope']?.['env:Body']
        const resp       = body?.['ns2:rRetEnviDe']?.['ns2:rProtDe']?.['ns2:gResProc']
        const primerResp = Array.isArray(resp) ? resp[0] : resp
        const mensaje    = Array.isArray(resp)
          ? resp.map(r => r?.['ns2:dMsgRes']).filter(Boolean).join(' | ')
          : primerResp?.['ns2:dMsgRes'] || null
        return {
          aprobado: false,
          codigo:   primerResp?.['ns2:dCodRes'] || 'ERR',
          mensaje,
          xmlRespuesta: JSON.stringify(parsed),
          enviadoEn, respondidoEn: new Date(), duracionMs: Date.now() - inicio,
        }
      } catch (_) {}
    }
    console.error('SIFEN conexión error:', err.message)
    return {
      aprobado: false, codigo: 'ERR',
      mensaje: `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null, enviadoEn, respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  }
}

const sum = (items, fn) => items.reduce((s, i) => s + (fn(i) || 0), 0)
function calcularMontoTotal(p) { return p.montoTotal  ?? sum(p.items || [], i => i.precioTotal) }
function calcularIVA10(p)      { return p.montoIVA10  ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)       { return p.montoIVA5   ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p)     { return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
