const fs = require('fs');
const config = require('config');

let limitPolygon = config.get('limits.polygon');

if (typeof limitPolygon === 'string') {
  limitPolygon = JSON.parse(fs.readFileSync(limitPolygon).toString());
}

const prerender = config.get('prerender');
let prerenderPolygon;

if (prerender && typeof prerender.polygon === 'string') {
  prerenderPolygon = JSON.parse(fs.readFileSync(prerender.polygon).toString());
}

module.exports = {
  limitPolygon,
  prerenderPolygon,
};
