# The staging instance, for a second checkout (such as the dev branch) on a
# host that also runs the live one: services.glimway-dev, units
# glimway-dev-server and glimway-dev, ports 8091 and 4174, and the admin
# command glimway-dev-server. See docs/home-server.md, "Dev Glimway (staging)".
import ./instance.nix {
  name = "glimway-dev";
  title = "Glimway dev";
  port = 8091;
  webPort = 4174;
}
