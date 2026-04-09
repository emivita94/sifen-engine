-- =============================================
-- SIFEN ENGINE - Esquema de base de datos
-- Multitenant con aislamiento por tenant_id
-- =============================================

-- Extensiones necesarias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================
-- TENANTS (empresas clientes del SaaS)
-- =============================================
CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre          VARCHAR(200) NOT NULL,
  ruc             VARCHAR(20) NOT NULL UNIQUE,   -- 12345678-9
  razon_social    VARCHAR(255) NOT NULL,
  -- Certificado digital encriptado con AES-256 (PKCS#12 en base64)
  certificado_enc TEXT,                          -- encriptado en la app
  cert_alias      VARCHAR(100),
  cert_vencimiento DATE,
  -- Config SIFEN
  ambiente        VARCHAR(10) DEFAULT 'test',    -- test | prod
  codigo_seguridad VARCHAR(9),                   -- codigo de seguridad del timbrado
  -- Estado
  activo          BOOLEAN DEFAULT true,
  plan            VARCHAR(20) DEFAULT 'starter', -- starter | pro | enterprise
  -- Metadata
  creado_en       TIMESTAMPTZ DEFAULT now(),
  actualizado_en  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tenants_ruc ON tenants(ruc);
CREATE INDEX idx_tenants_activo ON tenants(activo);

-- =============================================
-- API KEYS por tenant
-- =============================================
CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre      VARCHAR(100) NOT NULL,             -- "Producción", "Desarrollo"
  key_hash    VARCHAR(64) NOT NULL UNIQUE,       -- SHA-256 del key real
  key_prefix  VARCHAR(10) NOT NULL,              -- "sk_live_xxxx" para UI
  activa      BOOLEAN DEFAULT true,
  ultimo_uso  TIMESTAMPTZ,
  creada_en   TIMESTAMPTZ DEFAULT now(),
  expira_en   TIMESTAMPTZ                        -- NULL = sin vencimiento
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- =============================================
-- ESTABLECIMIENTOS por tenant
-- =============================================
CREATE TABLE IF NOT EXISTS establecimientos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  codigo          VARCHAR(3) NOT NULL,           -- "001"
  nombre          VARCHAR(200) NOT NULL,
  direccion       VARCHAR(500),
  ciudad_codigo   INT,
  ciudad_nombre   VARCHAR(100),
  departamento_codigo INT,
  activo          BOOLEAN DEFAULT true
);

CREATE UNIQUE INDEX idx_estab_tenant_codigo ON establecimientos(tenant_id, codigo);

-- =============================================
-- PUNTOS DE EXPEDICIÓN por establecimiento
-- =============================================
CREATE TABLE IF NOT EXISTS puntos_expedicion (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  establecimiento_id  UUID NOT NULL REFERENCES establecimientos(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  codigo              VARCHAR(3) NOT NULL,       -- "001"
  descripcion         VARCHAR(200),
  activo              BOOLEAN DEFAULT true
);

CREATE UNIQUE INDEX idx_punto_estab_codigo ON puntos_expedicion(establecimiento_id, codigo);

-- =============================================
-- TIMBRADOS por tenant/establecimiento/punto
-- =============================================
CREATE TABLE IF NOT EXISTS timbrados (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  establecimiento_id  UUID NOT NULL REFERENCES establecimientos(id),
  punto_id            UUID NOT NULL REFERENCES puntos_expedicion(id),
  numero_timbrado     VARCHAR(8) NOT NULL,       -- "12345678"
  tipo_documento      INT NOT NULL,              -- 1=Factura, 4=Autofactura, 5=NC, etc.
  numero_actual       BIGINT DEFAULT 1,          -- secuencial actual
  numero_max          BIGINT DEFAULT 9999999,
  vigencia_desde      DATE NOT NULL,
  vigencia_hasta      DATE NOT NULL,
  activo              BOOLEAN DEFAULT true,
  creado_en           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_timbrados_tenant ON timbrados(tenant_id);
CREATE INDEX idx_timbrados_activo ON timbrados(tenant_id, activo);

-- =============================================
-- DOCUMENTOS ELECTRÓNICOS (DEs)
-- El corazón del sistema
-- =============================================
CREATE TABLE IF NOT EXISTS documentos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  timbrado_id     UUID NOT NULL REFERENCES timbrados(id),

  -- Identificación del DE
  cdc             VARCHAR(44) UNIQUE,            -- Código de Control (CDC) - lo asigna la app
  tipo_documento  INT NOT NULL,                  -- 1=Factura, 5=NC, 6=ND, etc.
  numero          VARCHAR(15) NOT NULL,           -- "001-001-0000001"
  numero_secuencia BIGINT NOT NULL,

  -- Estado en el ciclo de vida SIFEN
  estado          VARCHAR(20) DEFAULT 'pendiente',
  -- pendiente -> firmado -> enviado -> aprobado
  -- pendiente -> firmado -> enviado -> rechazado
  -- aprobado -> cancelado
  -- pendiente -> inutilizado

  -- Datos del receptor
  receptor_tipo    INT,                          -- 1=RUC, 2=CI, 3=Pasaporte, 4=Innominado
  receptor_doc     VARCHAR(20),
  receptor_razon   VARCHAR(255),
  receptor_pais    VARCHAR(3) DEFAULT 'PRY',

  -- Montos (en guaraníes)
  monto_total      BIGINT NOT NULL DEFAULT 0,
  monto_iva_10     BIGINT DEFAULT 0,
  monto_iva_5      BIGINT DEFAULT 0,
  monto_exento     BIGINT DEFAULT 0,

  -- XML
  xml_generado     TEXT,                         -- XML antes de firmar
  xml_firmado      TEXT,                         -- XML firmado (lo que se envía a SET)
  xml_aprobado     TEXT,                         -- XML de respuesta de SET

  -- Respuesta de SIFEN
  sifen_codigo     VARCHAR(5),                   -- "0260" = Aprobado
  sifen_mensaje    TEXT,
  sifen_env_en     TIMESTAMPTZ,
  sifen_resp_en    TIMESTAMPTZ,

  -- Payload original del cliente (para reenvíos)
  payload_json     JSONB NOT NULL,

  -- Metadata
  referencia_ext   VARCHAR(100),                 -- ID del sistema del cliente
  webhook_url      VARCHAR(500),                 -- notificar cuando cambie estado
  creado_en        TIMESTAMPTZ DEFAULT now(),
  actualizado_en   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_docs_tenant ON documentos(tenant_id);
CREATE INDEX idx_docs_cdc ON documentos(cdc);
CREATE INDEX idx_docs_estado ON documentos(tenant_id, estado);
CREATE INDEX idx_docs_numero ON documentos(tenant_id, numero);
CREATE INDEX idx_docs_ref_ext ON documentos(tenant_id, referencia_ext);
CREATE INDEX idx_docs_fecha ON documentos(tenant_id, creado_en DESC);

-- =============================================
-- LOGS DE INTENTOS SIFEN
-- Para debugging, reintentos y auditoría
-- =============================================
CREATE TABLE IF NOT EXISTS sifen_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  documento_id    UUID NOT NULL REFERENCES documentos(id),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  accion          VARCHAR(50) NOT NULL,          -- envio, consulta, cancelacion, inutilizacion
  request_xml     TEXT,
  response_xml    TEXT,
  codigo_resp     VARCHAR(5),
  mensaje_resp    TEXT,
  duracion_ms     INT,
  exitoso         BOOLEAN DEFAULT false,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sifen_logs_doc ON sifen_logs(documento_id);
CREATE INDEX idx_sifen_logs_tenant ON sifen_logs(tenant_id, creado_en DESC);

-- =============================================
-- TRIGGER: actualiza updated_at automáticamente
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.actualizado_en = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_documentos_updated
  BEFORE UPDATE ON documentos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- WEBHOOK LOGS
-- Historial de intentos de notificación al ERP
-- =============================================
CREATE TABLE IF NOT EXISTS webhook_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  documento_id    UUID NOT NULL REFERENCES documentos(id),
  evento          VARCHAR(30) NOT NULL,      -- de.aprobado, de.rechazado, etc.
  url             VARCHAR(500) NOT NULL,
  numero_intento  INT NOT NULL DEFAULT 1,
  payload         JSONB NOT NULL,
  http_status     INT,                       -- null si hubo error de red
  duracion_ms     INT,
  exitoso         BOOLEAN DEFAULT false,
  error_msg       TEXT,
  creado_en       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_webhook_logs_doc  ON webhook_logs(documento_id);
CREATE INDEX idx_webhook_logs_evt  ON webhook_logs(evento, exitoso);

-- =============================================
-- MIGRACIONES
-- =============================================

-- Webhook HMAC-SHA256: secret por tenant para firmar webhooks
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(128);
