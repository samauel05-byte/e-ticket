# -*- mode: ruby -*-
# Máquina virtual de PRUEBA con VirtualBox (Windows, Linux y macOS con procesador Intel/AMD).
# Crea un Ubuntu 22.04, instala Docker y levanta el sistema con datos de ejemplo.
#
#   vagrant up                 crea y arranca todo (la primera vez tarda 10-15 min)
#   vagrant ssh                entra a la máquina
#   vagrant halt / destroy     apaga / borra la máquina
#   vagrant provision --provision-with actualizar   baja los últimos cambios y reconstruye
#
# Sistema:  http://localhost:3000      Bandeja de correos de prueba:  http://localhost:8025
# Variables opcionales: ETICKET_BRANCH (rama a instalar), EXPOSE_LAN=1 (abrir a otros equipos de la red),
#                       VM_MEMORY (MB, por defecto 2048), VM_CPUS (por defecto 2)

def rama_actual
  IO.popen(["git", "rev-parse", "--abbrev-ref", "HEAD"], err: File::NULL, &:read).to_s.strip
rescue StandardError
  ""
end
branch = ENV["ETICKET_BRANCH"] || rama_actual
branch = "main" unless branch =~ /\A[\w.\/-]+\z/ && branch != "HEAD"
bind_ip = ENV["EXPOSE_LAN"] == "1" ? nil : "127.0.0.1"

Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/jammy64"
  config.vm.hostname = "eticket-prueba"
  config.vm.boot_timeout = 600

  # Sin carpeta compartida: el código se descarga dentro de la máquina (evita problemas de permisos en Windows)
  config.vm.synced_folder ".", "/vagrant", disabled: true

  config.vm.network "forwarded_port", guest: 3000, host: 3000, host_ip: bind_ip, auto_correct: true
  config.vm.network "forwarded_port", guest: 8025, host: 8025, host_ip: bind_ip, auto_correct: true

  config.vm.provider "virtualbox" do |vb|
    vb.name = "eticket-prueba"
    vb.memory = (ENV["VM_MEMORY"] || 2048).to_i
    vb.cpus = (ENV["VM_CPUS"] || 2).to_i
  end

  config.vm.provision "shell", name: "instalar", env: { "BRANCH" => branch }, inline: <<-'SHELL'
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl git
    command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
    usermod -aG docker vagrant
    if [ ! -d /home/vagrant/e-ticket ]; then
      git clone --branch "$BRANCH" https://github.com/samauel05-byte/e-ticket /home/vagrant/e-ticket
    fi
    cd /home/vagrant/e-ticket
    ./scripts/test-env.sh up
    chown -R vagrant:vagrant /home/vagrant/e-ticket
  SHELL

  config.vm.provision "shell", name: "actualizar", run: "never", inline: <<-'SHELL'
    set -e
    cd /home/vagrant/e-ticket
    git pull --ff-only
    ./scripts/test-env.sh up
  SHELL
end
