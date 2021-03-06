const path = require('path');
const fs = require('fs');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env')
});

const constants = require('./constants');
const { author, version, packagesDir, outdir } = constants;

const copyEntries = require("./copyEntries");

module.exports = function(env = {}) {
  env.pkg = env.pkg || [];
  if (typeof env.pkg === 'string') {
    env.pkg = [env.pkg];
  }
  const webpackConfigs = [];
  console.log(`
  #################################

    Building version version ${version}
    by ${author}
    Output dir: ${outdir}
    Display Name: ${constants.DISPLAY_NAME}
    IS_PRODUCTION: ${constants.IS_PRODUCTION}

  #################################
  `)

  fs.readdirSync(packagesDir).forEach((pkg) => {
    if (env.pkg.length > 0 && env.pkg.indexOf(pkg) === -1) {
      return console.log(`Skipping @sqltools/${pkg}`);
    }
    const pkgPath = `${packagesDir}/${pkg}`;
    if (!fs.lstatSync(pkgPath).isDirectory()) return;
    if (!fs.existsSync(`${pkgPath}/package.json`)) return;

    console.log(`Reading package @sqltools/${pkg} config`);
    const pkgJson = require(`${pkgPath}/package.json`);

    if (pkgJson.build) {
      console.log(`\t>> Found ${pkgJson.build.length} build entries`)
      pkgJson.build.forEach(({
        entries,
        type,
        externals = {},
      }) => {
        if (type === 'copy') {
          Object.keys(entries).forEach((name) => {
            const destnation = entries[name];
            let copyEntry = {
              from: path.resolve(pkgPath, name),
              to: path.resolve(outdir, destnation),
            };
            if (destnation.indexOf('file:') === 0) {
              const customData = require(path.resolve(pkgPath, destnation.replace(/^file:/, '')))(constants);
              copyEntry = {
                ...copyEntry,
                ...customData,
              }
            }

            copyEntries.push(copyEntry);
          });
        } else {
          webpackConfigs.push(require(`./webpack/${type}.config.js`)({
            entries,
            packagePath: pkgPath,
            externals,
          }));
        }
      })
    } else {
      console.log(`\t>> no build entries`)
    }
  });

  if (copyEntries.length > 0) {
    webpackConfigs.push(require(`./webpack/copy.config.js`)(copyEntries));
  }

  return webpackConfigs;
}