#!/usr/bin/env python3
"""Nix flake devShell scaffolder.

Two modes:
  --detect   Probe the host for nix capability. Print JSON, exit 0 on nix present.
  (default)  Write flake.nix (+ .gitignore, optional .envrc) for a devShell.

The script is deliberately language-agnostic. It performs NO project inspection
and ships NO built-in package maps. The calling agent is responsible for
deciding which toolchain/dev tools the project needs and supplying them via
repeated `--package <attr>` flags (the package list is empty by default).

Stdlib only; no third-party dependencies.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def run(cmd, capture=True, check=False, timeout=15):
    """Run a command; return CompletedProcess or None on failure/timeout."""
    try:
        return subprocess.run(
            cmd,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            text=True,
            timeout=timeout,
            check=check,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


def read_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


# ---------------------------------------------------------------------------
# detection
# ---------------------------------------------------------------------------

def nix_program():
    return shutil.which("nix")


def nix_version(nix_bin):
    r = run([nix_bin, "--version"])
    if r is None or r.returncode != 0:
        return None
    # e.g. "nix (Nix) 2.24.7" -> pull first version-looking token
    m = re.search(r"(\d+\.\d+(?:\.\d+)*)", r.stdout or "")
    return m.group(1) if m else (r.stdout or "").strip() or None


def flakes_enabled(nix_bin):
    if nix_bin is None:
        return False
    r = run([nix_bin, "flake", "--help"], timeout=15)
    return r is not None and r.returncode == 0


def is_nixos():
    if os.path.exists("/etc/NIXOS"):
        return True
    if shutil.which("nixos-version") is not None and run(["nixos-version"]) is not None:
        return True
    os_release = read_file("/etc/os-release")
    if os_release:
        for line in os_release.splitlines():
            if line.startswith("ID=") and line[3:].strip().strip('"') == "nixos":
                return True
    return False


def current_system():
    u = os.uname()
    machine = u.machine
    sysname = u.sysname
    nix_sys = {"Linux": "linux", "Darwin": "darwin"}.get(sysname, sysname.lower())
    return f"{machine}-{nix_sys}"


def detect():
    nix_bin = nix_program()
    info = {
        "nix": {
            "installed": nix_bin is not None,
            "version": nix_version(nix_bin) if nix_bin else None,
            "path": nix_bin,
        },
        "flakes_enabled": flakes_enabled(nix_bin) if nix_bin else False,
        "is_nixos": is_nixos(),
        "current_system": current_system(),
    }
    return info


# ---------------------------------------------------------------------------
# sanitization
# ---------------------------------------------------------------------------

def sanitize_name(name):
    if not name:
        raise SystemExit("error: --name is empty")
    cleaned = re.sub(r"[^A-Za-z0-9_ .+-]", "", name)
    cleaned = cleaned.strip()
    if not cleaned:
        raise SystemExit(f"error: --name {name!r} contains no usable characters")
    return cleaned


def escape_nix_string(s):
    # escape backslashes, double quotes, dollars (against ${...}) for a Nix
    # double-quoted string context
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("${", "\\${")


SAFE_ATTR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")


def sanitize_attr(attr):
    if not attr:
        raise SystemExit("error: empty --package attribute")
    if not SAFE_ATTR_RE.match(attr):
        raise SystemExit(
            f"error: --package {attr!r} is not a plausible nixpkgs attribute "
            "(use a valid nixpkgs attr path; e.g. nodejs, rustToolchain, python3)"
        )
    return attr


# ---------------------------------------------------------------------------
# codegen
# ---------------------------------------------------------------------------

FLAKE_TEMPLATE = """\
{{
  description = "{description}";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs?ref={ref}";

  outputs = {{ self, nixpkgs }}:
    let
      systems = [{systems}];
      forAllSystems = f: builtins.listToAttrs (map (s: {{ name = s; value = f s; }}) systems);
    in
    {{
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${{system}}; in
        {{
          default = pkgs.mkShell {{
            packages = {packages_expr};
            shellHook = ''
              echo "Welcome to the {name_nix} devShell"
            '';
          }};
        }});
    }};
}}
"""

GITIGNORE = """\
result
result-*
.direnv/
"""

ENVRC = """\
use flake
"""


def render_flake(description, ref, systems, packages, name_nix):
    systems_str = " ".join(f'"{s}"' for s in systems)
    if packages:
        packages_expr = "with pkgs; [ " + " ".join(packages) + " ]"
    else:
        packages_expr = "[ ]"
    return FLAKE_TEMPLATE.format(
        description=escape_nix_string(description),
        ref=escape_nix_string(ref),
        systems=systems_str,
        packages_expr=packages_expr,
        name_nix=name_nix,
    )


def write_file(path, content, force, dry_run):
    if os.path.exists(path) and not force:
        eprint(f"error: refusing to overwrite existing {path} (pass --force)")
        return False
    if dry_run:
        print(f"--- {path} (dry-run) ---")
        print(content, end="")
        print("--- end ---")
        return True
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"wrote {path}")
    return True


# ---------------------------------------------------------------------------
# codegen entry
# ---------------------------------------------------------------------------

def codegen(args):
    # gate on nix presence
    info = detect()
    if not info["nix"]["installed"]:
        eprint(
            "error: nix is not installed on this host. "
            "Use the project language's native scaffolder instead (e.g. "
            "cargo init / npm init -y / uv init / go mod init). "
            "No flake files will be written."
        )
        return 1

    target_dir = os.path.abspath(args.dir)
    name = sanitize_name(args.name or os.path.basename(target_dir.rstrip("/")) or "project")
    description = args.description or f"Developer shell for {name}"
    packages = [sanitize_attr(p) for p in (args.package or [])]
    systems = [s.strip() for s in args.systems.split(",") if s.strip()]
    if not systems:
        raise SystemExit("error: --systems list is empty")
    name_nix = escape_nix_string(name)

    os.makedirs(target_dir, exist_ok=True)
    flake_path = os.path.join(target_dir, "flake.nix")
    gitignore_path = os.path.join(target_dir, ".gitignore")
    envrc_path = os.path.join(target_dir, ".envrc")

    flake_content = render_flake(
        description=description,
        ref=args.ref,
        systems=systems,
        packages=packages,
        name_nix=name_nix,
    )

    if not write_file(flake_path, flake_content, args.force, args.dry_run):
        return 1
    write_file(gitignore_path, GITIGNORE, args.force, args.dry_run)
    if args.direnv:
        write_file(envrc_path, ENVRC, args.force, args.dry_run)

    if args.dry_run:
        return 0

    print()
    print("Next steps (the scaffolder writes files only; run these yourself):")
    print(f"  cd {target_dir}")
    print('  git add -A          # flakes only see git-tracked files')
    print('  nix flake lock      # generate flake.lock from inputs')
    print('  nix develop         # enter the devShell to verify it builds')
    if not info["flakes_enabled"]:
        print()
        print("NOTE: flakes do not appear to be enabled. Enable with:")
        print("  nix --extra-experimental-features 'nix-command flakes' flake lock")
        print("  (or set nix.settings.experimental-features = [ \"nix-command\" \"flakes\" ]")
        print("   on NixOS, then run the commands normally.)")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(
        prog="scaffold.py",
        description=(
            "Scaffold a Nix flake devShell. With --detect, probe the host and "
            "print JSON; otherwise write flake.nix (+ .gitignore, optional "
            ".envrc) into --dir."
        ),
    )
    p.add_argument("--detect", action="store_true", help="Probe host for nix capability and exit.")
    p.add_argument("--dir", default=".", help="Target directory (default: current dir).")
    p.add_argument("--name", default=None, help="Project name (default: dir basename).")
    p.add_argument("--description", default=None, help="Flake description (default: 'Developer shell for <name>').")
    p.add_argument(
        "--package",
        action="append",
        default=[],
        help="nixpkgs attribute to add to the devShell (repeatable; empty by default).",
    )
    p.add_argument("--ref", default="nixos-unstable", help="nixpkgs ref/branch (default: nixos-unstable).")
    p.add_argument(
        "--systems",
        default="x86_64-linux,aarch64-linux,x86_64-darwin,aarch64-darwin",
        help="Comma-separated Nix systems list.",
    )
    p.add_argument("--direnv", action="store_true", help="Also write a .envrc (requires nix-direnv).")
    p.add_argument("--force", action="store_true", help="Overwrite existing files.")
    p.add_argument("--dry-run", action="store_true", help="Print files that would be written; write nothing.")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.detect:
        info = detect()
        print(json.dumps(info, indent=2))
        return 0 if info["nix"]["installed"] else 1
    return codegen(args)


if __name__ == "__main__":
    sys.exit(main())