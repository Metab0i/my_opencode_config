---
name: nixos-consultant
description: Consult on NixOS configuration, usage, and administration. Covers installation, declarative configuration, package management, services, networking, desktop environments, containers, troubleshooting, and the Nix language. Uses search.nixos.org for packages and options, and the NixOS manual for reference.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  domain: nixos-consulting
---

## How to Use This Skill

This skill provides consulting guidance on NixOS. The NixOS ecosystem is vast -- do not attempt to memorize or reproduce every option or package detail. Instead:

1. **Understand the user's goal** -- identify what they want to achieve
2. **Fetch the relevant documentation** using the URLs below to get exact option names, package attributes, and configuration patterns
3. **Provide targeted guidance** -- explain the concept, point to the right options/packages, and show minimal configuration snippets
4. **Verify** -- when suggesting options or packages, use the search URLs to confirm they exist and are correctly named

## Core Concepts to Understand First

Before diving into configuration, ensure you understand these NixOS fundamentals:

- **Declarative configuration**: The entire system state is defined in `/etc/nixos/configuration.nix` (or a flake). `nixos-rebuild switch` makes the system match the declaration.
- **Reproducibility**: Same config produces same system. Generations allow rollback.
- **Nix store**: Packages live in `/nix/store/<hash>-<name>-<version>`. Paths are immutable.
- **Nix language**: Purely functional, lazily evaluated DSL. Not general-purpose. Key constructs: `let...in`, `{ }` (attribute sets), `[ ]` (lists), `with`, `import`, functions as `{ arg1, arg2 ? default, ... }: body`.
- **Flakes vs channels**: Flakes are the modern, reproducible approach. Channels are the legacy approach. Understand which the user is using before advising.
- **Modules system**: NixOS configuration is built from modules that declare and define options. `imports = [ ... ]` pulls in other modules. `config`, `pkgs`, `lib`, `modulesPath` are standard module arguments.
- **`lib` functions**: `lib.mkDefault`, `lib.mkForce`, `lib.mkOverride`, `lib.mkIf`, `lib.mkMerge`, `lib.optionals`, `lib.optionalAttrs` are essential for module composition.

## Documentation & Search Resources

### Primary Search Tools (use these to find specific packages and options)

- **Package search** (find packages by name, description, attribute path, version): https://search.nixos.org/packages
- **Option search** (find NixOS configuration options by name, description, module): https://search.nixos.org/options

When a user asks about a specific package or service, use these search tools to find the exact attribute name, available versions, and relevant options. Do not guess attribute names.

### NixOS Manual Sections

Fetch these URLs for detailed reference on specific topics:

- **Full manual** (table of contents, all chapters): https://nixos.org/manual/nixos/stable/
- **Configuration syntax** (Nix language in config context, module structure): https://nixos.org/manual/nixos/stable/#sec-configuration-syntax
- **Installation** (obtaining ISOs, partitioning, manual/graphical install): https://nixos.org/manual/nixos/stable/#sec-installation
- **Changing configuration** (nixos-rebuild, generations, rollback): https://nixos.org/manual/nixos/stable/#sec-changing-config
- **Upgrading NixOS** (channel updates, flake updates, version upgrades): https://nixos.org/manual/nixos/stable/#sec-upgrading
- **Package management** (nix-env, nix-shell, nix profile, declarative packages): https://nixos.org/manual/nixos/stable/#sec-package-management
- **User management** (users.users, users.groups, passwords, SSH keys): https://nixos.org/manual/nixos/stable/#sec-user-management
- **File systems** (fileSystems, swap, LVM, RAID, encryption): https://nixos.org/manual/nixos/stable/#ch-file-systems
- **X Window System** (X11, display managers, window managers): https://nixos.org/manual/nixos/stable/#sec-x11
- **Wayland** (Wayland compositors, display servers): https://nixos.org/manual/nixos/stable/#sec-wayland
- **GPU acceleration** (NVIDIA, AMD, Intel drivers): https://nixos.org/manual/nixos/stable/#sec-gpu-accel
- **Networking** (networking.*, systemd-networkd, NetworkManager, firewall, DNS, WiFi): https://nixos.org/manual/nixos/stable/#sec-networking
- **Linux kernel** (kernel packages, modules, parameters, boot.initrd): https://nixos.org/manual/nixos/stable/#sec-kernel-config
- **Service management** (systemctl, systemd units): https://nixos.org/manual/nixos/stable/#sec-systemctl
- **Logging** (journald, rsyslog): https://nixos.org/manual/nixos/stable/#sec-logging
- **Nix store GC** (garbage collection, nix-collect-garbage): https://nixos.org/manual/nixos/stable/#sec-nix-gc
- **Container management** (nixos-container, LXC): https://nixos.org/manual/nixos/stable/#ch-containers
- **Troubleshooting** (debugging, logs, rescue): https://nixos.org/manual/nixos/stable/#ch-troubleshooting
- **Writing NixOS modules** (module syntax, option declarations, types, mkEnableOption, mkPackageOption, submodules): https://nixos.org/manual/nixos/stable/#sec-writing-modules
- **NixOS tests** (writing and running integration tests): https://nixos.org/manual/nixos/stable/#sec-nixos-tests
- **Release notes** (breaking changes, new features per version): https://nixos.org/manual/nixos/stable/release-notes
- **All configuration options** (complete reference): https://nixos.org/manual/nixos/stable/options

### Related Manuals

- **Nix manual** (package manager, nix commands, flakes, store, profiles): https://nixos.org/manual/nix/stable/
- **Nixpkgs manual** (package overrides, overlays, callPackage, stdenv, build phases): https://nixos.org/manual/nixpkgs/stable/

## Consulting Workflow

### 1. Identify the NixOS Version

Ask or check which NixOS version the user is on. Options and packages change between releases. The stable manual URL (`/stable/`) tracks the current stable release. For version-specific docs, use `/nixos/<version>/`.

### 2. Determine Config Style

- **Flake-based**: `flake.nix` with `nixosConfigurations`. Commands use `nixos-rebuild --flake .#hostname`.
- **Channel-based**: `/etc/nixos/configuration.nix`. Commands use `nixos-rebuild switch`.

Advise accordingly -- flakes require different commands and have different reproducibility guarantees.

### 3. Use Search for Packages and Options

Before suggesting any package or option:
- Search https://search.nixos.org/packages for the exact attribute name (e.g., `pkgs.firefox`, not just "firefox")
- Search https://search.nixos.org/options for the exact option path (e.g., `services.nginx.enable`, not `services.nginx.enabled`)

### 4. Provide Minimal, Correct Snippets

Show only the relevant configuration block. Explain what each part does. Point to the manual section for full details.

### 5. Flag Breaking Changes

When advising on upgrades or new configurations, check the release notes for breaking changes that may affect the user's setup.

## Common Consulting Topics

### Installation & Setup
- Graphical vs minimal ISO, partitioning (UEFI vs BIOS), bootloader selection (systemd-boot vs GRUB)
- `nixos-generate-config` produces initial config and `hardware-configuration.nix`
- Post-install: user accounts, networking, desktop environment

### Configuration Management
- `nixos-rebuild switch` (apply), `boot` (apply on next boot), `test` (apply without bootloader entry), `dry-activate` (preview changes)
- Generations stored in `/nix/var/nix/profiles/system-*`, selectable from boot menu
- Rollback: `nixos-rebuild switch --rollback` or select previous generation at boot

### Package Management
- Declarative: `environment.systemPackages = [ pkgs.foo pkgs.bar ]` in config
- Imperative (user-level): `nix profile install nixpkgs#foo` (flakes) or `nix-env -iA nixpkgs.foo` (channels)
- Development shells: `nix develop nixpkgs#foo` or `nix-shell -p foo`
- Difference between system packages and user packages

### Services
- Most services follow `services.<name>.enable = true` pattern
- Search https://search.nixos.org/options with `services.` prefix to find available service options
- Services are managed by systemd; use `systemctl status <service>` to check

### Networking
- NetworkManager vs systemd-networkd vs declarative `networking.interfaces`
- Firewall: `networking.firewall.allowedTCPPorts`, `allowedUDPPorts`, `enable`
- DNS, hosts, domain, WiFi configuration

### Desktop Environments & Display Servers
- X11: `services.xserver.enable = true`, then `services.xserver.displayManager.*` and `services.xserver.desktopManager.*`
- Wayland: compositor-specific config (GNOME, KDE, Sway, Hyprland, etc.)
- GPU drivers: `hardware.opengl.enable`, `services.xserver.videoDrivers`, NVIDIA-specific `hardware.nvidia`

### Security
- Firewall, sudo configuration, SSH hardening
- ACME/Let's Encrypt certificates: `security.acme`
- TPM2, full disk encryption (LUKS), secure boot
- User passwords: `users.users.<name>.hashedPassword` or `initialPassword`

### Containers & Virtualization
- NixOS containers (LXC-based): `containers.<name>`
- Docker/Podman: `virtual.docker.enable`, `virtualisation.podman.enable`
- VirtualBox, libvirt/QEMU

### Nix Language & Module Writing
- Option declarations: `options.<path> = lib.mkOption { type = ...; default = ...; description = ...; }`
- Option types: `lib.types.str`, `lib.types.bool`, `lib.types.int`, `lib.types.listOf`, `lib.types.attrsOf`, `lib.types.submodule`, `lib.types.enum`, `lib.types.nullOr`
- Conditional config: `lib.mkIf condition { ... }`
- Merging config: `lib.mkMerge [ { ... } { ... } ]`
- Priority modifiers: `lib.mkDefault`, `lib.mkForce`, `lib.mkOverride priority`
- `mkEnableOption "description"` creates a boolean enable option

## Critical Gotchas

- **Attribute names are exact**: `services.openssh.enable` not `services.ssh.enable` or `services.sshd.enable`. Always verify via search.
- **Nix is lazy**: Errors may not surface until the value is actually used. A typo in an unused option won't fail until that option is evaluated.
- **`with` scope pollution**: `with pkgs; [ foo bar ]` is convenient but can cause name collisions. Prefer explicit `pkgs.foo` in module code.
- **Immutable store paths**: You cannot modify files in `/nix/store`. Derivations must be rebuilt.
- **`/etc` is managed**: Files in `/etc` are symlinks into the Nix store. Do not edit them directly -- changes will be lost on rebuild.
- **Flakes require `--experimental-features "nix-command flakes"`** or the settings in `nix.conf`.
- **`nixos-rebuild` requires root** (or appropriate sudo access).
- **Hardware configuration is auto-generated**: `hardware-configuration.nix` is produced by `nixos-generate-config` and should not be manually edited in most cases. It gets overwritten on re-run.
- **Option merging**: Multiple modules can define the same option. The module system merges them according to the option's type and merge function. Use `lib.mkForce` to override.
- **NixOS version pinning**: With flakes, the `nixpkgs` input URL determines the version. With channels, `nix-channel --list` shows the current channel. Mismatched versions between config and nixpkgs cause errors.
- **`pkgs` vs `inputs.nixpkgs.legacyPackages`**: In flakes, you typically use `inputs.nixpkgs.legacyPackages.${system}` instead of the implicit `pkgs`.

## When the User Needs More

- For package-specific configuration (e.g., "how do I configure nginx?"): search options at https://search.nixos.org/options with `services.nginx`
- For package availability/version: search at https://search.nixos.org/packages
- For Nix language details: https://nixos.org/manual/nixpkgs/stable/#chap-nix-language
- For writing custom modules: https://nixos.org/manual/nixos/stable/#sec-writing-modules
- For troubleshooting: https://nixos.org/manual/nixos/stable/#ch-troubleshooting
- For upgrade path between versions: https://nixos.org/manual/nixos/stable/release-notes
