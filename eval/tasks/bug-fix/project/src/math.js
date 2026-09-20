function sum(values) {
  let total;
  for (const v of values) total = (total ?? 0) + v;
  return total;
}
module.exports = { sum };
