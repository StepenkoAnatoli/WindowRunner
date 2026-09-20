const api = require("./api.js");
function report(id) {
  return "report: " + api.fetchUser(id).name;
}
module.exports = { report };
