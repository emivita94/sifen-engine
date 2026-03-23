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
  const codigoSeguridad  = (tenant.codigoSeguridad || '123456789').toString().padStart(9, '0').substring(0, 9)
  const idCSC            = tenant.idCsc || '0001'

  // ── 4. Params ───────────────────────────────────────────────────────────────
  const timbradoFecha = new Date(timbrado.vigenciaDesde).toISOString().split('T')[0]

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

    // Enviar a SIFEN (o guardar en modo debug)
    sifen = await enviarASIFEN(xmlFirmado, tenant.ambiente, tmpCert, certPassword, cdc)

  } catch (err) {
    return respuestaError('Error firmando, generando QR o enviando el DE', err.message)
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

// ── Enviar a SIFEN ────────────────────────────────────────────────────────────
async function enviarASIFEN(xmlFirmado, ambiente, certPath, certPassword, cdc = '') {
  const inicio    = Date.now()
  const enviadoEn = new Date()

  // ── MODO DEBUG: agregar SKIP_SIFEN=true en Railway Variables ─────────────
  // El XML se guarda en /tmp/preview/ y se imprime completo en los logs
  // Desactivar quitando la variable o poniendo SKIP_SIFEN=false
  if (process.env.SKIP_SIFEN === 'true') {
    try {
      mkdirSync('/tmp/preview', { recursive: true })
      const filename = `DE_${cdc || Date.now()}.xml`
      const filepath = join('/tmp/preview', filename)
      writeFileSync(filepath, xmlFirmado, 'utf8')
      console.log('=== SKIP_SIFEN ACTIVO — XML NO ENVIADO A SIFEN ===')
      console.log('Archivo:', filepath)
      console.log('=== XML COMPLETO ===')
      console.log(xmlFirmado)
      console.log('=== FIN XML ===')
    } catch (e) {
      console.error('Error guardando preview:', e.message)
    }
    return {
      aprobado:     false,
      codigo:       'SKIP',
      mensaje:      'SKIP_SIFEN activo — XML generado y logueado sin enviar a SIFEN',
      xmlRespuesta: null,
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }
  }

  // ── ENVÍO REAL A SIFEN ────────────────────────────────────────────────────
  try {
    const env = ambiente === 'prod' ? 'prod' : 'test'

    // setapi.recibe() hace split("\n").slice(1) para quitar el <?xml?>
    const xmlParaEnviar = xmlFirmado.replace(/^(<\?xml[^?]*\?>)/, '$1\n')

    const r = await _setapi.recibe(
      1,
      xmlParaEnviar,
      env,
      certPath,
      certPassword,
      { timeout: config.sifen.timeoutMs }
    )

    console.log('SIFEN RESPONSE:', JSON.stringify(r))

    const resp       = r?.['ns2:rRetEnviDe']?.['ns2:rProtDe']?.['ns2:gResProc']
    const primerResp = Array.isArray(resp) ? resp[0] : resp
    const aprobado   = ['0260', '0422'].includes(primerResp?.['ns2:dCodRes'])

    const mensaje = Array.isArray(resp)
      ? resp.map(r => r?.['ns2:dMsgRes']).filter(Boolean).join(' | ')
      : primerResp?.['ns2:dMsgRes'] || null

    return {
      aprobado,
      codigo:       primerResp?.['ns2:dCodRes'] || null,
      mensaje,
      xmlRespuesta: JSON.stringify(r) || null,
      enviadoEn,
      respondidoEn: new Date(),
      duracionMs:   Date.now() - inicio,
    }
  } catch (err) {
    return {
      aprobado: false, codigo: 'ERR',
      mensaje: `Error de conexión con SIFEN: ${err.message}`,
      xmlRespuesta: null, enviadoEn, respondidoEn: new Date(), duracionMs: Date.now() - inicio,
    }
  }
}

// ── Cálculos ──────────────────────────────────────────────────────────────────
const sum = (items, fn) => items.reduce((s, i) => s + (fn(i) || 0), 0)
function calcularMontoTotal(p) { return p.montoTotal  ?? sum(p.items || [], i => i.precioTotal) }
function calcularIVA10(p)      { return p.montoIVA10  ?? sum((p.items||[]).filter(i=>i.tasaIVA===10), i=>Math.round(i.precioTotal*10/110)) }
function calcularIVA5(p)       { return p.montoIVA5   ?? sum((p.items||[]).filter(i=>i.tasaIVA===5),  i=>Math.round(i.precioTotal*5/105)) }
function calcularExento(p)     { return p.montoExento ?? sum((p.items||[]).filter(i=>i.tasaIVA===0),  i=>i.precioTotal) }
