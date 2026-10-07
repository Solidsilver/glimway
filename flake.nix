{
  description = "Glimway server, static web app and configurable NixOS service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in rec {
          glimway-server = pkgs.callPackage ./nix/server.nix { };
          glimway-web = pkgs.callPackage ./nix/web.nix { };
          default = glimway-server;
        });

      nixosModules.default = import ./deploy/nixos/glimway.nix;
      nixosModules.glimway = self.nixosModules.default;

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.mkShell {
            packages = with pkgs; [ go nodejs_24 sqlite libwebp git-lfs ];
          };
        });

      checks = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          inherit (self.packages.${system}) glimway-server glimway-web;
          nixos-module = import ./nix/module-check.nix { inherit pkgs nixpkgs; };
        });
    };
}
