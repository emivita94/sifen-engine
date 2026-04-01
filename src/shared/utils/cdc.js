// src/shared/utils/cdc.js
// Generador del CDC (Código de Control del Documento Electrónico)
// Según Manual Técnico SIFEN v150
//
// Estructura del CDC (44 dígitos):
// [2] iTipDE + [8] dRucEm + [1] dDVEm + [3] dEstab + [3] dPunExp
// + [7] dNumDoc + [1] iTImp + [8] dNumTim + [8] dFecEm + [1] iAmb
// + [3] iTiOpe + [1 dígito verificador]

/**
 * Calcula el dígito verificador del CDC usando el módulo 11
 */
function digitoVerificadorCDC(cdc43) {
  const k = [2, 3, 4, 5, 6, 7, 8, 9]
  let sum = 0
  for (let i = cdc43.length - 1; i >= 0; i--) {
    sum += parseInt(cdc43[i]) * k[(cdc43.length - 1 - i) % k.length]
  }
  const resto = sum % 11
  return resto >= 2 ? (11 - resto).toString() : resto.toString()
}

/**
 * Genera el CDC de 44 dígitos para un DE
 *
 * @param {Object} params
 * @param {number} params.tipoDE          - Tipo de documento (1=Factura, 4=Autofactura, 5=NC, 6=ND, 7=NC por Devolución)
 * @param {string} params.rucEmisor       - RUC sin DV (ej: "12345678")
 * @param {string} params.dvEmisor        - Dígito verificador del RUC (ej: "9")
 * @param {string} params.establecimiento - Código establecimiento 3 dígitos (ej: "001")
 * @param {string} params.puntoExpedicion - Código punto expedición 3 dígitos (ej: "001")
 * @param {number} params.numero          - Número secuencial 7 dígitos
 * @param {number} params.tipoTransaccion - 1=Venta, 2=Import, 3=Export, 4=A tercero, 5=Gasto
 * @param {string} params.numeroTimbrado  - Número de timbrado 8 dígitos (ej: "12345678")
 * @param {Date}   params.fechaEmision    - Fecha de emisión del DE
 * @param {number} params.ambiente        - 1=Producción, 2=Test
 */
export function generarCDC({
  tipoDE,
  rucEmisor,
  dvEmisor,
  establecimiento,
  puntoExpedicion,
  numero,
  tipoTransaccion = 1,
  numeroTimbrado,
  fechaEmision,
  ambiente = 2,
}) {
  // Formatea fecha como YYYYMMDD
  const fecha = fechaEmision instanceof Date ? fechaEmision : new Date(fechaEmision)
  const fechaStr = [
    fecha.getFullYear().toString(),
    (fecha.getMonth() + 1).toString().padStart(2, '0'),
    fecha.getDate().toString().padStart(2, '0'),
  ].join('')

  // Construye los 43 caracteres base
 const base = [
  tipoDE.toString().padStart(2, '0'),                    // [2] iTipDE
  (rucEmisor + dvEmisor.toString()).padStart(9, '0'),    // [9] RUC+DV
  establecimiento.toString().padStart(3, '0'),           // [3] dEstab
  puntoExpedicion.toString().padStart(3, '0'),           // [3] dPunExp
  numero.toString().padStart(7, '0'),                    // [7] dNumDoc
  tipoTransaccion.toString(),                            // [1] iTImp
  fechaStr,                                              // [8] dFecEm
  codigoSeguridad.toString().padStart(9, '0').substring(1, 9), // [8] CSA
  ambiente.toString(),                                   // [1] iAmb
].join('')

  if (base.length !== 43) {
    throw new Error(`CDC base inválida: ${base.length} chars en lugar de 43. CDC: ${base}`)
  }

  const dv = digitoVerificadorCDC(base)
  return base + dv
}

/**
 * Parsea un CDC de 44 dígitos y retorna sus partes
 */
export function parsearCDC(cdc) {
  if (cdc.length !== 44) throw new Error('CDC inválido: debe tener 44 dígitos')
  return {
    tipoDE:          parseInt(cdc.substring(0, 2)),
    rucEmisor:       cdc.substring(2, 10).replace(/^0+/, ''),
    dvEmisor:        cdc.substring(10, 11),
    establecimiento: cdc.substring(11, 14),
    puntoExpedicion: cdc.substring(14, 17),
    numero:          parseInt(cdc.substring(17, 24)),
    tipoTransaccion: parseInt(cdc.substring(24, 25)),
    numeroTimbrado:  cdc.substring(25, 33),
    fechaEmision:    cdc.substring(33, 41),
    ambiente:        parseInt(cdc.substring(41, 42)),
    iTiOpe:          cdc.substring(42, 45),
    dvCDC:           cdc.substring(43, 44),
  }
}

/**
 * Valida que un CDC sea correcto verificando su dígito verificador
 */
export function validarCDC(cdc) {
  if (!cdc || cdc.length !== 44) return false
  const base = cdc.substring(0, 43)
  const dvEsperado = digitoVerificadorCDC(base)
  return cdc.substring(43) === dvEsperado
}
