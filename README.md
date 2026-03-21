# SIFEN Engine

Motor de facturación electrónica multitenant para Paraguay (SIFEN/SET).

## Stack

- **Runtime**: Node.js 20+ (ESM)
- **HTTP**: Fastify 4
- **BD**: PostgreSQL 14+
- **Libs SIFEN**: facturacionelectronicapy-xmlgen / xmlsign / setapi (npm, gratuitas)

## Estructura del proyecto

```
sifen-engine/
├── src/
│   ├── index.js                    ← Entry point Fastify
│   ├── config/index.js             ← Configuración centralizada
│   ├── db/
│   │   ├── connection.js           ← Pool PostgreSQL
│   │   └── schema.sql              ← Migraciones DDL
│   ├── shared/
│   │   ├── auth/plugin.js          ← Autenticación por API key
│   │   ├── crypto/index.js         ← Encriptación certs + hashing keys
│   │   └── utils/cdc.js            ← Generador/validador de CDC
│   └── modules/
│       ├── sifen/motor.js          ← ⭐ Motor principal: XML → firma → SIFEN
│       ├── documentos/routes.js    ← Endpoints REST de DEs
│       └── tenants/routes.js       ← Onboarding y config de tenants
├── .env.example
└── package.json
```

## Inicio rápido

```bash
# 1. Clonar e instalar
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tu DATABASE_URL, CERT_ENCRYPTION_KEY, etc.

# 3. Crear la BD
createdb sifen_engine
psql sifen_engine < src/db/schema.sql

# 4. Levantar en desarrollo
npm run dev
```

## Flujo de onboarding de un tenant

```
1. POST /api/v1/tenants
   { nombre, ruc: "12345678-9", razonSocial, ambiente: "test" }
   ← { apiKey: "sk_test_xxx..." }  ← Guardar esto, no se repite

2. POST /api/v1/tenants/:id/certificado
   { certificadoBase64: "...", alias: "mi-empresa" }

3. POST /api/v1/tenants/:id/establecimientos
   { codigo: "001", nombre: "Casa Central" }

4. POST /api/v1/tenants/:id/establecimientos/:estId/puntos
   { codigo: "001", descripcion: "Caja 1" }

5. POST /api/v1/tenants/:id/timbrados
   { establecimientoId, puntoId, numeroTimbrado: "12345678",
     tipoDocumento: 1, vigenciaDesde, vigenciaHasta }
```

## Emitir una factura

```bash
curl -X POST http://localhost:3000/api/v1/documentos \
  -H "X-API-Key: sk_test_xxx..." \
  -H "Content-Type: application/json" \
  -d '{
    "tipoDocumento": 1,
    "receptor": {
      "tipo": 1,
      "documento": "80000001-1",
      "razonSocial": "Cliente S.A."
    },
    "items": [
      {
        "descripcion": "Servicio de desarrollo web",
        "cantidad": 1,
        "precioUnitario": 1000000,
        "precioTotal": 1000000,
        "tasaIVA": 10
      }
    ]
  }'
```

## Seguridad

### Certificados digitales
Los certificados PKCS#12 se encriptan con AES-256-GCM antes de almacenarlos.
La clave de encriptación vive solo en `CERT_ENCRYPTION_KEY` (env), nunca en BD.

### API keys
Se almacena solo el hash SHA-256 del key. El key real se muestra una sola vez
al crear y no se puede recuperar.

## Arquitectura multitenant

Todos los registros incluyen `tenant_id`. PostgreSQL Row Level Security (RLS)
puede activarse para aislamiento a nivel de BD en versiones enterprise.

## Próximos pasos sugeridos

- [ ] Implementar cola de reintentos para cuando SIFEN no responde
- [ ] Webhooks para notificar al cliente cuando el DE cambia de estado
- [ ] Generación de KUDE en PDF
- [ ] Panel web de administración
- [ ] Eventos SIFEN: cancelación, inutilización, conformidad
- [ ] Consulta de estado de DEs (polling a SIFEN)
- [ ] Docker + docker-compose para deploy
