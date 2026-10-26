# CuentaClara

Aplicación web para calcular el importe restante tras una devolución y consultar los movimientos por día.

## Requisitos

- Node.js 22.13 o posterior. La aplicación usa `node:sqlite`, incluido en Node.js, y no necesita dependencias externas.

## Iniciar en local

Desde esta carpeta, ejecuta:

```sh
npm start
```

Abre <http://127.0.0.1:3000> en el navegador. Puedes cambiar el puerto con `PORT` y el host con `HOST`. En Coolify, el Dockerfile configura el host interno como `0.0.0.0` para que el proxy pueda acceder al servidor.

## Datos y configuración

Los importes se guardan como céntimos enteros en SQLite. La base de datos se crea en `data/devoluciones.sqlite` en local o en la carpeta indicada por `DATA_DIR`. La fecha y hora de cada movimiento usan la zona horaria `Europe/Madrid`.

La pantalla abre por defecto la fecha actual (hora de Madrid), aunque todavía no haya movimientos ese día. El selector permite consultar los demás días; cada nuevo cálculo se guarda con la fecha y hora actuales.

En el histórico puedes seleccionar un mes y descargar todas sus devoluciones en un archivo `.xlsx`, con un resumen mensual y una fila por movimiento.

Variables de entorno:

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Interfaz donde escucha Node.js. |
| `PORT` | `3000` | Puerto interno del servidor. |
| `BASE_PATH` | vacío | Prefijo público, por ejemplo `/CuentaClara`. |
| `DATA_DIR` | `data/` del proyecto | Carpeta que contiene la base SQLite. |

## Desplegar en Coolify bajo `joanaps.dev/CuentaClara`

El repositorio incluye un `Dockerfile` listo para desplegar como aplicación Dockerfile desde Git. Coolify construye la imagen, enruta el dominio y puede emitir el certificado HTTPS. La app conserva el prefijo `/CuentaClara` tanto si el proxy de Coolify lo elimina antes de reenviar la petición como si conserva la ruta completa.

### 1. Preparar el dominio y Coolify

1. Crea o revisa el registro DNS `A` de `joanaps.dev` y apunta a la IP pública del VPS.
2. Comprueba que los puertos TCP `80` y `443` llegan al proxy de Coolify. No hace falta publicar el puerto `3000` en Internet.
3. En Coolify, confirma que el servidor usa el proxy integrado (Traefik o Caddy) y que está iniciado.

Si `joanaps.dev` ya sirve otra web, la ruta `/CuentaClara` puede compartir ese mismo dominio mediante una ruta por prefijo de Coolify. Revisa que no exista ya otra aplicación asignada a esa misma ruta.

### 2. Crear la aplicación desde Git

1. En Coolify, abre un proyecto y un entorno, pulsa **New Resource** y crea una aplicación desde el proveedor Git conectado. También puedes usar el repositorio público `https://github.com/joanaps92/RegDev.git`.
2. Selecciona la rama `main`.
3. En **Build Pack** o método de construcción, elige **Dockerfile**.
4. Deja **Base Directory** como `/` y configura **Dockerfile Location** como `/Dockerfile` (o `Dockerfile`, según la versión del panel).
5. Guarda la aplicación.

### 3. Configurar el puerto y las variables

En la configuración general de la aplicación establece **Ports Exposes** en `3000`. No añadas un mapeo de puerto público.

En **Environment Variables**, añade estos valores de ejecución:

```text
HOST=0.0.0.0
PORT=3000
BASE_PATH=/CuentaClara
DATA_DIR=/data
```

El Dockerfile ya incluye estos valores; declararlos en Coolify deja visible la configuración del despliegue y permite cambiarla desde el panel.

### 4. Guardar los movimientos en almacenamiento persistente

Los contenedores se reemplazan en cada despliegue. Si SQLite queda en el sistema de archivos temporal del contenedor, podrías perder movimientos. Antes del primer despliegue:

1. Abre **Persistent Storage** en la configuración de la aplicación.
2. Añade un **Volume Mount** administrado por Docker.
3. Configura **Destination Path** como `/data`.
4. Guarda el montaje.

El contenedor ejecuta Node como el usuario `node`; el Dockerfile prepara `/data` con permisos para ese usuario. Comprueba que Coolify monte el volumen en esa ruta y que la app pueda escribir en él antes de registrar devoluciones reales. El volumen evita que los despliegues normales eliminen los datos, pero no sustituye a las copias de seguridad.

### 5. Añadir el dominio y la ruta

En **Domains**, pulsa **Add domain** y rellena los campos:

- **Protocol:** `https`
- **Domain:** `joanaps.dev`
- **Port:** `3000`
- **Path:** `/CuentaClara`

La URL resultante será `https://joanaps.dev/CuentaClara`. Deja desactivado **Keep paths as-is in Path prefixes** si aparece en **Advanced > Proxy**; esa es la opción predeterminada. La aplicación también admite esa opción activada.

Coolify gestiona el enrutamiento y el certificado TLS. Si no se emite el certificado, comprueba el DNS y que los puertos `80` y `443` del VPS lleguen al proxy.

### 6. Proteger el acceso y desplegar

La aplicación todavía no tiene cuentas de usuario propias. Para que el histórico y el formulario no queden abiertos a cualquier visitante:

1. En **General > Security > Authentication**, activa **HTTP Basic Authentication**.
2. Crea un usuario y una contraseña robusta. Guárdala en un gestor de contraseñas; no la pongas en el Dockerfile ni en Git. Mantén **Container labels > Label management** en el modo administrado por Coolify para que genere las reglas de autenticación del proxy.
3. Despliega la aplicación desde Coolify.

Al terminar, abre `https://joanaps.dev/CuentaClara`. El navegador debe pedir las credenciales y, después, mostrar el calculador y el histórico.

### 7. Actualizar y respaldar

Cuando publiques cambios en la rama `main`, Coolify puede desplegarlos automáticamente si activas los despliegues automáticos del repositorio. También puedes iniciar el despliegue manualmente desde la aplicación.

Configura copias de seguridad del volumen desde Coolify si esa opción está disponible para tu tipo de almacenamiento. Guarda además una copia fuera del VPS y realiza una restauración de prueba antes de depender de ella. Un volumen persistente protege los datos frente a reemplazos de contenedor, pero no frente a fallos o pérdida del servidor.

### Referencias oficiales

- [Dominios, puertos y rutas con prefijo en Coolify](https://coolify.io/docs/core/networking/domains).
- [Aplicaciones Dockerfile en Coolify](https://coolify.io/docs/applications/builds/dockerfile).
- [Almacenamiento persistente en Coolify](https://coolify.io/docs/applications/configuration/persistent-storage).
- [Autenticación básica en el proxy de Coolify](https://coolify.io/docs/core/networking/proxy/traefik/basic-auth).
- [Descargas y versiones LTS de Node.js](https://nodejs.org/en/download) y [documentación de `node:sqlite`](https://nodejs.org/api/sqlite.html).
