'use strict';

const { resolve } = require('../index');
const yaml = require('yaml');
const fs = require('fs');

const FILENAME = "/Users/rbagga/git/oas-kit/packages/oas-resolver/spec/openapi.yaml";

const options = {
    "resolve": true,
    "jsonSchema": true,
    // "filters": [
    //     null
    // ],
    "source": FILENAME,
    "origin": FILENAME,
    cache: [],
    externals: [],
    externalRefs: {},
    rewriteRefs: true,
    verbose: 2,
    hoistResolvedComponents: true
};

(async () => {
    let content = fs.readFileSync(FILENAME, "utf8");
    const parsedSpec = yaml.parse(content, { prettyErrors: true });

    try {
        const resolved = await resolve(parsedSpec, FILENAME, options);

        fs.writeFileSync("./dev-test/spec/openapi.json", JSON.stringify(resolved.openapi, null, 2), 'utf8');
    } catch (err) {
        console.error("oh no! " + err);
        throw err;
    }

})();
