# Caja de devoluciones

Aplicación web local para calcular el importe restante tras una devolución y consultar los movimientos por día.

## Requisitos

- Node.js 22.13 o posterior. La aplicación usa `node:sqlite`, incluido en Node.js, y no necesita instalar dependencias.

## Iniciar

Desde esta carpeta, ejecuta:

```sh
npm start
```

Abre <http://127.0.0.1:3000> en el navegador. Para cambiar el puerto, define `PORT` antes de iniciar el servidor.

## Datos

Los importes se guardan como céntimos enteros en SQLite. La base de datos se crea automáticamente en `data/devoluciones.sqlite`; la fecha y hora de cada movimiento usan la zona horaria `Europe/Madrid`. La carpeta `data/` se excluye de Git para mantener los registros del equipo fuera del código fuente.

La pantalla abre por defecto el día más reciente con movimientos. El selector de fecha permite consultar los demás días; cada nuevo cálculo se guarda con la fecha y hora actuales.

## Despliegue en un servidor web

Esta guía usa un VPS con Ubuntu Server 24.04, Node.js 24 LTS, Nginx y un dominio propio. La aplicación no incluye cuentas de usuario: Nginx añadirá una contraseña compartida y Certbot activará HTTPS. No publiques el sitio sin esa protección; cualquier persona que llegue a la aplicación podría consultar el histórico y guardar movimientos.

### 1. Preparar el dominio y el VPS

Necesitas:

- Un VPS Ubuntu Server 24.04 con acceso SSH y permisos `sudo`.
- Un dominio o subdominio, por ejemplo `devoluciones.ejemplo.es`, cuyo registro DNS `A` apunte a la IP pública del VPS.
- En el cortafuegos del proveedor, permitir SSH y los puertos TCP 80 y 443. No abras el puerto 3000.

Los comandos siguientes usan `devoluciones.ejemplo.es` como ejemplo. Sustitúyelo por tu dominio.

### 2. Instalar Node.js, Nginx y herramientas

Conéctate al VPS por SSH y ejecuta:

```sh
sudo apt update
sudo apt install -y ca-certificates curl nginx apache2-utils snapd rsync ufw

curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs

node --version
npm --version
```

Comprueba que Node.js sea 22.13 o posterior. La aplicación no necesita `npm install`: no tiene dependencias externas.

### 3. Crear el usuario y las carpetas de la aplicación

El proceso de Node se ejecutará como un usuario del sistema sin acceso interactivo:

```sh
sudo useradd --system --home /var/lib/caja-devoluciones --create-home --shell /usr/sbin/nologin caja-devoluciones
sudo install -d -o root -g root -m 755 /opt/caja-devoluciones/app
```

En el VPS, prepara una carpeta temporal para recibir los archivos:

```sh
mkdir -p ~/caja-devoluciones-upload
```

Desde tu ordenador, abre una terminal en la carpeta del proyecto (la que contiene `package.json`) y copia el código. Cambia `USUARIO_SSH` y `IP_O_DOMINIO` por los datos de acceso al VPS:

```sh
rsync -av --exclude='.git/' --exclude='data/' ./ USUARIO_SSH@IP_O_DOMINIO:~/caja-devoluciones-upload/
```

Vuelve a la terminal del VPS y copia los archivos a la ubicación definitiva:

```sh
sudo rsync -a --delete --exclude='data/' ~/caja-devoluciones-upload/ /opt/caja-devoluciones/app/
sudo chown -R root:root /opt/caja-devoluciones/app
sudo install -d -o caja-devoluciones -g caja-devoluciones -m 750 /opt/caja-devoluciones/app/data
```

La carpeta `data/` se excluye al copiar el código para que las actualizaciones no borren la base de datos.

#### Opcional: trasladar registros de este equipo

Si ya tienes movimientos en `data/devoluciones.sqlite`, cierra la aplicación local antes de copiar ese archivo. En el VPS, crea la carpeta temporal:

```sh
mkdir -p ~/caja-devoluciones-upload/data
```

Desde el ordenador local, en la carpeta del proyecto:

```sh
rsync -av data/devoluciones.sqlite USUARIO_SSH@IP_O_DOMINIO:~/caja-devoluciones-upload/data/
```

En el VPS, antes de iniciar el servicio por primera vez:

```sh
sudo install -o caja-devoluciones -g caja-devoluciones -m 640 \
  ~/caja-devoluciones-upload/data/devoluciones.sqlite \
  /opt/caja-devoluciones/app/data/devoluciones.sqlite
```

### 4. Configurar el servicio de Node

Crea el servicio de `systemd`:

```sh
sudo nano /etc/systemd/system/caja-devoluciones.service
```

Pega este contenido:

```ini
[Unit]
Description=Caja de devoluciones
After=network.target

[Service]
Type=simple
User=caja-devoluciones
Group=caja-devoluciones
WorkingDirectory=/opt/caja-devoluciones/app
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
ExecStart=/usr/bin/node /opt/caja-devoluciones/app/server.js
Restart=on-failure
RestartSec=5
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/caja-devoluciones/app/data

[Install]
WantedBy=multi-user.target
```

Guarda el archivo y activa el servicio:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now caja-devoluciones
sudo systemctl status caja-devoluciones --no-pager
curl -I http://127.0.0.1:3000
```

La base de datos se creará en `/opt/caja-devoluciones/app/data/devoluciones.sqlite`.

### 5. Configurar Nginx y la contraseña

Crea un usuario y contraseña para abrir la aplicación. Nginx pedirá estas credenciales en el navegador:

```sh
sudo htpasswd -c /etc/nginx/.htpasswd-caja operadora
sudo chown root:www-data /etc/nginx/.htpasswd-caja
sudo chmod 640 /etc/nginx/.htpasswd-caja
```

Para añadir otra cuenta después, ejecuta `sudo htpasswd /etc/nginx/.htpasswd-caja otro-usuario` sin `-c`, para conservar la cuenta anterior.

Crea la configuración del sitio:

```sh
sudo nano /etc/nginx/sites-available/caja-devoluciones
```

Pega el bloque siguiente y cambia el dominio de ejemplo:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name devoluciones.ejemplo.es;

    location ^~ /.well-known/acme-challenge/ {
        auth_basic off;
        root /var/www/html;
    }

    location / {
        auth_basic "Caja de devoluciones";
        auth_basic_user_file /etc/nginx/.htpasswd-caja;

        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activa y revisa la configuración:

```sh
sudo ln -s /etc/nginx/sites-available/caja-devoluciones /etc/nginx/sites-enabled/caja-devoluciones
sudo nginx -t
sudo systemctl reload nginx
```

### 6. Activar HTTPS y limitar el acceso de red

Instala Certbot desde Snap y solicita un certificado para el dominio. El DNS ya debe apuntar al VPS y el puerto 80 debe poder recibir conexiones desde internet:

```sh
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
sudo certbot --nginx -d devoluciones.ejemplo.es
```

Si Certbot pregunta, elige redirigir HTTP a HTTPS. Después, revisa que la configuración del servidor HTTPS conserve `auth_basic` y `auth_basic_user_file`. Comprueba la renovación automática:

```sh
sudo certbot renew --dry-run
```

Activa el cortafuegos del VPS. La regla SSH debe estar permitida antes de activar UFW para no perder el acceso remoto:

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

No permitas conexiones externas al puerto 3000. Nginx es el único punto de entrada, y el servicio Node escucha solo en `127.0.0.1`.

### 7. Comprobar el acceso

Abre `https://devoluciones.ejemplo.es` en un navegador. Debe solicitar el usuario y la contraseña de Nginx y, tras introducirlos, mostrar la aplicación. En el VPS puedes consultar el estado y los registros del servicio con:

```sh
sudo systemctl status caja-devoluciones --no-pager
sudo journalctl -u caja-devoluciones -n 50 --no-pager
```

### Actualizar la aplicación

Desde el ordenador local, vuelve a copiar el código a `~/caja-devoluciones-upload/` con el comando `rsync` del paso 3. En el VPS, aplica los archivos y reinicia el servicio:

```sh
sudo systemctl stop caja-devoluciones
sudo rsync -a --delete --exclude='data/' ~/caja-devoluciones-upload/ /opt/caja-devoluciones/app/
sudo chown -R root:root /opt/caja-devoluciones/app
sudo chown -R caja-devoluciones:caja-devoluciones /opt/caja-devoluciones/app/data
sudo systemctl start caja-devoluciones
sudo systemctl status caja-devoluciones --no-pager
```

### Copias de seguridad

Detén el servicio antes de copiar SQLite. Así se cierra la base de datos y se evita copiarla mientras está escribiendo:

```sh
sudo systemctl stop caja-devoluciones
sudo install -d -m 700 /var/backups/caja-devoluciones
sudo cp /opt/caja-devoluciones/app/data/devoluciones.sqlite \
  "/var/backups/caja-devoluciones/devoluciones-$(date +%F-%H%M).sqlite"
sudo systemctl start caja-devoluciones
```

Repite esta copia con la frecuencia que necesite el trabajo y guarda además una copia fuera del VPS. Para restaurar una copia, detén el servicio, sustituye `data/devoluciones.sqlite`, asigna el archivo a `caja-devoluciones` y vuelve a iniciar el servicio.

### Referencias oficiales

- [Descargas y versiones LTS de Node.js](https://nodejs.org/en/download) y [documentación de `node:sqlite`](https://nodejs.org/api/sqlite.html).
- [Instrucciones de NodeSource para Debian y Ubuntu](https://github.com/nodesource/distributions#debian-and-ubuntu-based-distributions).
- [Documentación de proxy de Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) y [autenticación básica de Nginx](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html).
- [Instrucciones de Certbot para Nginx](https://certbot.eff.org/instructions).
