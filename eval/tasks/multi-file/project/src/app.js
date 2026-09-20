const { fetchUser } = require("./api.js");
function describe(id) {
  return "app sees " + fetchUser(id).name;
}
module.exports = { describe };
