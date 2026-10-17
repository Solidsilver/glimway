# The live instance: services.glimway, units glimway-server and glimway,
# ports 8090 and 4173. Its names and defaults must not change.
import ./instance.nix {
  name = "glimway";
  title = "Glimway";
  port = 8090;
  webPort = 4173;
  installPackage = true;
}
