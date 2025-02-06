'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

const fetch = require('node-fetch-h2');
const yaml = require('yaml');

const jptr = require('reftools/lib/jptr.js').jptr;
const recurse = require('reftools/lib/recurse.js').recurse;
const clone = require('reftools/lib/clone.js').clone;
const deRef = require('reftools/lib/dereference.js').dereference;
const isRef = require('reftools/lib/isref.js').isRef;
const common = require('oas-kit-common');

const HOISTABLE_COMPONENT_SECTIONS = {
    'schemas': [ 'properties', 'items', 'schema', 'schemas' ],
    'examples': [ 'examples' ]
}

const HOISTABLE_COMPONENT_SECTION_LOOKUP = Object.entries(HOISTABLE_COMPONENT_SECTIONS).reduce(
    (result, entry) => {
        const [ section, keys ] = entry;

        keys.forEach(key => {
            result[key] = section;
        });

        return result;
    }, {}
)

function unique(arr) {
    return [... new Set(arr)];
}

function readFileAsync(filename, encoding, options, pointer, def) {
    return new Promise(function (resolve, reject) {
        fs.readFile(filename, encoding, function (err, data) {
            if (err) {
                if (options.ignoreIOErrors && def) {
                    if (options.verbose) console.warn('FAILED',pointer);
                    options.externalRefs[pointer].failed = true;
                    resolve(def);
                }
                else {
                    reject(err);
                }
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
 * Prefix to track component paths that are discriminator mapping refs, not regular $refs.
 * Gets injected and stripped during processing.
 */
const DISC_MAPPING_MARKER = "DM://";

/** Prefix for discriminator mapping related x-miro properties */
const X_MIRO_FOR_KEY_PREFIX = 'x-miro_';

/** Faux enum to declare RefTypes that are discovered */
const RefType = {
    /** Basic $ref key with target value */
    $REF: "$ref",
    /** A Discriminator mapping, whose keys are dynamic and are identifies as refs by their enclosing context. */
    DISC_MAPPING: 'DISCRIMINATOR_MAPPING'
};

/**
 * Test if the given key of the given object is a reference and return the reference target if it is, else return false.
 * In the common case where a reference is defined by a $ref key, this returns the value of that key.
 * This function also supports finding a reference in a discriminator mapping and will return that value if found.
 * Return values are wrapped in an object with a type (See `RefType`) to identify which type was found.
 *
 * @param enclosingObj from scanExternalRefs.inner()
 * @param key from scanExternalRefs.inner()
 * @param state from scanExternalRefs.inner()
 * @return {boolean|{ $ref: string, type: string }} False if not a ref, else an object with the ref and its type.
 */
function getIfReference(enclosingObj, key, state) {
    // Simple case, a regular `$ref`:
    if (isRef(enclosingObj, key)) {
        return {
            $ref: enclosingObj.$ref,
            type: RefType.$REF
        };
    }
    else {
        return getIfDiscrMappingReference(enclosingObj, key, state);
    }
}

/**
 * Test if the given object is a discriminator type mapping with properties that are named refs, and if the
 * given key is one of those properties within this object, and return the reference target and type (DISC_MAPPING),
 * if it is, else return false.
 *
 * @param enclosingObj from scanExternalRefs.inner()
 * @param key from scanExternalRefs.inner()
 * @param state from scanExternalRefs.inner()
 * @return {boolean|{ $ref: string, type: string }} False if not a ref, else an object with the ref and a type of RefType.DISC_MAPPING
 */
function getIfDiscrMappingReference(enclosingObj, key, state) {
    if (key.startsWith(X_MIRO_FOR_KEY_PREFIX)) {
        return false;
    }

    // Check for discriminator mapping edge case. The only way to know this is by parent and grand-parent context.
    // The state contains the parent by name in the `pKey` property, but to get the grand-parent we have to look at the
    // `path` property, which has the full ancestry, but in slash-delimited path style.
    // If this is a discriminator, ref, then the path will look like this:
    // '#/components/.../discriminator/mapping/<mapping-key>
    // We must look for that `/discriminator/mapping` ancestry.
    const discriminatorMappingRe = /.+\/discriminator\/mapping\/([^\/]+)$/;
    // The regex path will also match cases where enclosingObj is not a string, as the recursion goes down. But
    // that case doesn't fit.

    const pathMatches = discriminatorMappingRe.exec(state.path); // array

    if (pathMatches !== null) {
        const pathKey = pathMatches[1];
        if (pathKey === key && typeof enclosingObj === "object") {
            return {
                $ref: enclosingObj[key],
                type: RefType.DISC_MAPPING
            };
        }
    }
    return false;
}

/**
 * Resolves all fragments within an object, replacing references with their actual values.
 *
 * @param {Object} obj - The object to resolve fragments within.
 * @param {Object} context - The context object containing the data to resolve references against.
 * @param {string} src - The source URL or path of the object.
 * @param {string} parentPath - The parent path of the object.
 * @param {string} base - The base URL or path for resolving references.
 * @param {Object} options - Options for resolving fragments.
 * @param {Object} options.externalRefs - A map of external references.
 * @param {boolean} [options.ignoreIOErrors=false] - Whether to ignore I/O errors.
 * @param {boolean} [options.verbose=false] - Whether to log verbose output.
 * @param {boolean} [options.fatal=false] - Whether to throw an error on failure.
 * @param {boolean} [options.promise=false] - Whether to use promises for error handling.
 * @param {number} [options.verbose=0] - Verbosity level for logging.
 * @returns {Object} The object with resolved fragments.
 */
function resolveAllFragment(obj, context, src, parentPath, base, options) {

    let attachPoint = options.externalRefs[src+parentPath].paths[0];

    let baseUrl = url.parse(base);
    let seen = {}; // seen is indexed by the $ref value and contains path replacements
    let changes = 1;
    while (changes) {
        changes = 0;
        recurse(obj, {identityDetection:true}, function (obj, key, state) {
            let possibleRef = getIfReference(obj, key, state);
            if (possibleRef) {
                const { type: refType } = possibleRef;
                if (obj[key].startsWith('#')) {
                    if (!seen[obj[key]] && !obj.$fixed) {
                        let target = clone(jptr(context, obj[key]));
                        if (options.verbose>1) console.warn((target === false ? common.colour.red : common.colour.green)+'Fragment resolution', obj[key], common.colour.normal);
                        /*
                            ResolutionCase:A is where there is a local reference in an externally
                            referenced document, and we have not seen it before. The reference
                            is replaced by a copy of the data pointed to, which may be outside this fragment
                            but within the context of the external document
                        */
                        if (target === false) {
                            state.parent[state.pkey] = {}; /* case:A(2) where the resolution fails */
                            if (options.fatal) {
                                let ex = new Error('Fragment $ref resolution failed '+obj[key]);
                                if (options.promise) options.promise.reject(ex)
                                else throw ex;
                            }
                        }
                        else {
                            changes++;
                            state.parent[state.pkey] = target;
                            seen[obj[key]] = state.path.replace('/%24ref','');
                        }
                    }
                    else {
                        if (!obj.$fixed) {
                            let newRef = (attachPoint+'/'+seen[obj[key]]).split('/#/').join('/');
                            state.parent[state.pkey] = { $ref: newRef, 'x-miro': obj[key], $fixed: true };
                            if (options.verbose>1) console.warn('Replacing with',newRef);
                            changes++;
                        }
                        /*
                            ResolutionCase:B is where there is a local reference in an externally
                            referenced document, and we have seen this reference before and resolved it.
                            We create a new object containing the (immutable) $ref string
                        */
                    }
                }
                else if (baseUrl.protocol) {
                    let newRef = url.resolve(base,obj[key]).toString();
                    if (options.verbose>1) console.warn(common.colour.yellow+'Rewriting external url ref',obj[key],'as',newRef,common.colour.normal);
                    obj['x-miro'] = obj[key];
                    if (options.externalRefs[obj[key]]) {
                        if (!options.externalRefs[newRef]) {
                            options.externalRefs[newRef] = options.externalRefs[obj[key]];
                        }
                        options.externalRefs[newRef].failed = options.externalRefs[obj[key]].failed;
                    }
                    obj[key] = newRef;
                }
                else {
                    // We found an external reference

                    // inject (if not already done) a key peer to the ref key that temporarily contains the original
                    // ref value that will also serve as an indicator that we have already found the external target.
                    // Then replace the original value itself with the (external) resolved value.
                    const xMiroKey = refType === RefType.DISC_MAPPING ? X_MIRO_FOR_KEY_PREFIX + key : 'x-miro';
                    if (!obj[xMiroKey]) {
                        let newRef = url.resolve(base, obj[key]).toString();
                        let failed = false;
                        if (options.externalRefs[obj[key]]) {
                            failed = options.externalRefs[obj[key]].failed;
                        }
                        if (!failed) {
                            if (options.verbose>1) console.warn(common.colour.yellow+'Rewriting external ref',obj[key],'as',newRef,common.colour.normal);
                            obj[xMiroKey] = obj[key]; // we use x-miro as a flag so we don't do this > once
                            obj[key] = newRef;
                        }
                    }
                }
            }
        });
    }

    recurse(obj,{},function(obj,key,state){
        if (getIfReference(obj, key, state)) {
            if (typeof obj.$fixed !== 'undefined') delete obj.$fixed;
        }
    });

    if (options.verbose>1) console.warn('Finished fragment resolution');
    return obj;
}

/**
 * Applies the series of filters from `options` to the provided data.
 *
 * @param {Object} data - The data to be filtered.
 * @param {Object} options - The options object containing the filters.
 * @param {Function[]} [options.filters] - An array of filter functions to apply to the data.
 * @returns {Object} The filtered data.
 */
function filterData(data, options) {
    if (!options.filters || !options.filters.length) return data;
    for (let filter of options.filters) {
        data = filter(data, options);
    }
    return data;
}

function testProtocol(input, backup) {
    if (input && input.length > 2) return input;
    if (backup && backup.length > 2) return backup;
    return 'file:';
}

/**
 * Resolves an external reference within an OpenAPI document.
 *
 * @param {Object} root - The root object of the OpenAPI document.
 * @param {string} pointer - The JSON pointer to the external reference.
 * @param {Object} options - Options for resolving the external reference.
 * @param {string} options.source - The source URL or path of the OpenAPI document.
 * @param {Object} options.cache - A cache for storing resolved references.
 * @param {Object} options.externalRefs - A map of external references.
 * @param {boolean} [options.ignoreIOErrors=false] - Whether to ignore I/O errors.
 * @param {boolean} [options.verbose=false] - Whether to log verbose output.
 * @param {boolean} [options.fatal=false] - Whether to throw an error on failure.
 * @param {boolean} [options.promise=false] - Whether to use promises for error handling.
 * @param {Object} options.handlers - Custom handlers for different protocols.
 * @param {Object} options.fetchOptions - Options for the fetch function.
 * @param {Object} options.agent - The agent to use for HTTP requests.
 * @param {Function} callback - The callback function to call with the resolved data.
 * @returns {Promise<Object>} A promise that resolves with the resolved data.
 */
function resolveExternal(root, pointer, options, callback) {
    var u = url.parse(options.source);
    var base = options.source.split('\\').join('/').split('/');
    let doc = base.pop(); // drop the actual filename
    if (!doc) base.pop(); // in case it ended with a /
    let fragment = '';
    let fnComponents = pointer.split('#');
    if (fnComponents.length > 1) {
        fragment = '#' + fnComponents[1];
        pointer = fnComponents[0];
    }
    base = base.join('/');

    let u2 = url.parse(pointer);
    let effectiveProtocol = testProtocol(u2.protocol, u.protocol);

    let target;
    if (effectiveProtocol === 'file:') {
        target = path.resolve(base ? base + '/' : '', pointer);
    }
    else {
        target = url.resolve(base ? base + '/' : '', pointer);
    }

    if (options.cache[target]) {
        if (options.verbose) console.warn('CACHED', target, fragment);
        /*
            resolutionSource:A this is where we have cached the externally-referenced document from a
            file, http or custom handler
        */
        let context = clone(options.cache[target]);
        let data = options.externalRef = context;
        if (fragment) {
            data = jptr(data, fragment);
            if (data === false) {
                data = {}; // case:A(2) where the resolution fails
                if (options.fatal) {
                    let ex = new Error('Cached $ref resolution failed '+target+fragment);
                    if (options.promise) options.promise.reject(ex)
                    else throw ex;
                }
            }
        }
        data = resolveAllFragment(data, context, pointer, fragment, target, options);
        data = filterData(data, options);
        callback(clone(data), target, options);
        return Promise.resolve(data);
    }

    if (options.verbose) console.warn('GET', target, fragment);

    if (options.handlers && options.handlers[effectiveProtocol]) {
        return options.handlers[effectiveProtocol](base, pointer, fragment, options)
            .then(function (data) {
                options.externalRef = data;
                data = filterData(data, options);
                options.cache[target] = data;
                callback(data, target, options);
                return data;
            })
            .catch(function(ex){
                if (options.verbose) console.warn(ex);
                throw ex;
            });
    }
    else if (effectiveProtocol && effectiveProtocol.startsWith('http')) {
        const fetchOptions = Object.assign({}, options.fetchOptions, { agent: options.agent });
        return options.fetch(target, fetchOptions)
            .then(function (res) {
                if (res.status !== 200) {
                  if (options.ignoreIOErrors) {
                    if (options.verbose) console.warn('FAILED',pointer);
                    options.externalRefs[pointer].failed = true;
                    return '{"$ref":"'+pointer+'"}';
                  }
                  else {
                    throw new Error(`Received status code ${res.status}: ${target}`);
                  }
                }
                return res.text();
            })
            .then(function (data) {
                try {
                    let context = yaml.parse(data, { schema:'core', prettyErrors: true });
                    data = options.externalRef = context;
                    options.cache[target] = clone(data);
                    /* resolutionSource:B, from the network, data is fresh, but we clone it into the cache */
                    if (fragment) {
                        data = jptr(data, fragment);
                        if (data === false) {
                            data = {}; /* case:B(2) where the resolution fails */
                            if (options.fatal) {
                                let ex = new Error('Remote $ref resolution failed '+target+fragment);
                                if (options.promise) options.promise.reject(ex)
                                else throw ex;
                            }
                        }
                    }
                    data = resolveAllFragment(data, context, pointer, fragment, target, options);
                    data = filterData(data, options);
                }
                catch (ex) {
                    if (options.verbose) console.warn(ex);
                    if (options.promise && options.fatal) options.promise.reject(ex)
                    else throw ex;
                }
                callback(data, target, options);
                return data;
            })
            .catch(function (err) {
                if (options.verbose) console.warn(err);
                options.cache[target] = {};
                if (options.promise && options.fatal) options.promise.reject(err)
                else throw err;
            });
    }
    else {
        const def = '{"$ref":"'+pointer+'"}';
        return readFileAsync(target, options.encoding || 'utf8', options, pointer, def)
            .then(function (data) {
                try {
                    let context = yaml.parse(data, { schema:'core', prettyErrors: true });
                    data = options.externalRef = context;
                    /*
                        resolutionSource:C from a file, data is fresh but we clone it into the cache
                    */
                    options.cache[target] = clone(data);
                    if (fragment) {
                        data = jptr(data, fragment);
                        if (data === false) {
                            data = {}; /* case:C(2) where the resolution fails */
                            if (options.fatal) {
                                let ex = new Error('File $ref resolution failed '+target+fragment);
                                if (options.promise) options.promise.reject(ex)
                                else throw ex;
                            }
                        }
                    }
                    data = resolveAllFragment(data, context, pointer, fragment, target, options);
                    data = filterData(data, options);
                }
                catch (ex) {
                    if (options.verbose) console.warn(ex);
                    if (options.promise && options.fatal) options.promise.reject(ex)
                    else throw ex;
                }
                callback(data, target, options);
                return data;
            })
            .catch(function(err){
                if (options.verbose) console.warn(err);
                if (options.promise && options.fatal) options.promise.reject(err)
                else throw err;
            });
    }
}

function buildComponentName(section, ref, openapi, idx = -1) {
    const name = `#/components/${section}/${path.basename(ref)}` + (idx >= 0 ? `-${idx}` : '');

    idx = idx + 1;

    const existingJptr = jptr(openapi, name);

    return existingJptr ? buildComponentName(section, ref, openapi, idx) : name;
}


/**
 * Determines the hoisted pointer for a given reference within an OpenAPI document.
 *
 * @param {string} ptr - The JSON pointer to the reference.
 * @param {string} ref - The reference string.
 * @param {Object} openapi - The OpenAPI document.
 * @returns {string} The hoisted pointer.
 */
function determineHoistedPtr(ptr, ref, openapi) {

    // check to see if this is a direct ref to a component; if so don't worry about hoisting
    // it up since its already hoisted
    if (ptr.startsWith("#/components") && ptr.split("/").length === 4) {
        return ptr;
    }

    // determine what type of component we have by looking at where it was pointed to.
    // this is a naive approach; but is probably the best we can do.

    // limit the number of things we look at; wan't to avoid accidentally assigning the
    // component to the wrong section. (ie; if we have #/components/schemas/Thing/examples/my-example)
    // we DON'T want to accidentally assign the result to a schema instead of an example
    const ptrParts = ptr.split('/').reverse().slice(0, 3);

    const possibleSections = ptrParts
        .map(part => HOISTABLE_COMPONENT_SECTION_LOOKUP[part])
        .filter(part => !!part);

    const possibleSection = possibleSections.length > 0 ?
        possibleSections[0] :
        null;


    // if we don't know what section it belongs to fall back to
    if (!possibleSection) {
        return ptr;
    }

    // did we find a possible match? If so, use the first one
    return buildComponentName(possibleSection, ref, openapi);
}

function scanExternalRefs(options) {
    return new Promise(function (res, rej) {

        /**
         * For each property in the spec, we are going to recursively walk its value and
         * this function is the callback visitor for any object type property encountered.
         *
         * It records any found reference into the closure declared variable `refs`.
         *
         * @param obj The object property in the spec
         * @param key The key of the property for which object is a value.
         * @param state A persistent state of the recursive operation to track things like "position" in the document
         */
        function inner(obj,key,state){
            if (obj[key]) {
                let refType;
                let $ref;

                // Determine a) if obj[key] is an object with a reference, and b) if it contains a basic $ref with a
                // single OpenAPI ref, or a Discriminator mapping which can contain multiple refs, one for each key.
                const isBasicRef = isRef(obj[key], '$ref');
                let possibleDiscriminatorMappingRef = false;
                if (isBasicRef) {
                    refType = RefType.$REF;
                    $ref = obj[key].$ref;
                } else {
                    possibleDiscriminatorMappingRef = getIfDiscrMappingReference(obj, key, state);
                    if (possibleDiscriminatorMappingRef) {
                        refType = possibleDiscriminatorMappingRef.type; // RefType.DISC_MAPPING
                        $ref = possibleDiscriminatorMappingRef.$ref;
                    }
                }

                if (isBasicRef || possibleDiscriminatorMappingRef) {
                    if (!$ref.startsWith('#')) { // is external

                        let $extra = '';

                        if (!refs[$ref]) {
                            let potential = Object.keys(refs).find(function(e,i,a){
                                return $ref.startsWith(e+'/');
                            });
                            if (potential) {
                                if (options.verbose) console.warn('Found potential subschema at',potential);
                                $extra = '/'+($ref.split('#')[1]||'').replace(potential.split('#')[1]||'');
                                $extra = $extra.split('/undefined').join(''); // FIXME
                                $ref = potential;
                            }
                        }

                        if (!refs[$ref]) {
                            refs[$ref] = { resolved: false, paths: [], extras:{}, description: obj[key].description };
                        }
                        if (refs[$ref].resolved) {
                            // we've already seen it
                            if (refs[$ref].failed) {
                                // do none
                            }
                            else if (options.rewriteRefs) {
                                let newRef = refs[$ref].resolvedAt;
                                if (options.verbose>1) console.warn('Rewriting ref', $ref, newRef);
                                if (refType === RefType.$REF) {
                                    obj[key]['x-miro'] = $ref;
                                    obj[key].$ref = newRef+$extra; // resolutionCase:C1 (new string)
                                }
                                else if (refType === RefType.DISC_MAPPING) {
                                    obj[key][X_MIRO_FOR_KEY_PREFIX + key] = $ref;
                                    obj[key] = newRef + $extra; // resolutionCase: C2 (new DM string)
                                }
                                else {
                                    // Report, but just ignore for now.
                                    console.error("Should never happen, unexpected ref type:", refType);
                                }
                            }
                            else {
                                obj[key] = clone(refs[$ref].data); // resolutionCase:D (cloned:yes)
                            }
                        }
                        else {
                            let storedStatePath = state.path;
                            if (refType === RefType.DISC_MAPPING) {
                                // We need to not just store the path to the thing that has a ref to `$ref`,
                                // but also whether it was a DM mapping, since they are modelled differently.
                                // Kludge: inject this fact as a prefix on the path. Will be stripped on consumption.
                                storedStatePath = DISC_MAPPING_MARKER + storedStatePath;
                            }
                            // Storing the path to the thing that is/has a ref to target `$ref` (the variable).
                            refs[$ref].paths.push(storedStatePath);
                            refs[$ref].extras[state.path] = $extra;
                        }
                    }
                }
            }
        }

        let refs = options.externalRefs;

        if ((options.resolver.depth>0) && (options.source === options.resolver.base)) {
            // we only need to do any of this when called directly on pass #1
            return res(refs);
        }

        recurse(options.openapi.definitions, {identityDetection: true, path: '#/definitions'}, inner);
        recurse(options.openapi.components, {identityDetection: true, path: '#/components'}, inner);
        recurse(options.openapi, {identityDetection: true}, inner);

        res(refs);
    });
}


/**
 * Build functions that find and resolves external references within an OpenAPI document.
 *
 * @param {Object} options - Options for finding and resolving external references.
 * @param {Object} options.openapi - The OpenAPI document.
 * @param {string} options.source - The source URL or path of the OpenAPI document.
 * @param {Object} options.cache - A cache for storing resolved references.
 * @param {Object} options.externalRefs - A map of external references.
 * @param {boolean} [options.ignoreIOErrors=false] - Whether to ignore I/O errors.
 * @param {boolean} [options.verbose=false] - Whether to log verbose output.
 * @param {boolean} [options.fatal=false] - Whether to throw an error on failure.
 * @param {boolean} [options.promise=false] - Whether to use promises for error handling.
 * @param {Object} options.handlers - Custom handlers for different protocols.
 * @param {Object} options.fetchOptions - Options for the fetch function.
 * @param {Object} options.agent - The agent to use for HTTP requests.
 * @param {boolean} [options.rewriteRefs=true] - Whether to rewrite references.
 * @param {boolean} [options.resolveInternal=false] - Whether to resolve internal references.
 * @param {boolean} [options.preserveMiro=false] - Whether to preserve 'x-miro' properties.
 * @param {Object[]} options.externals - An array to store external references.
 * @param {Object} options.resolver - Resolver options.
 * @param {number} options.resolver.depth - The current depth of the resolver.
 * @param {string} options.resolver.base - The base URL or path for resolving references.
 * @param {Function[][]} options.resolver.actions - An array of arrays of resolver actions.
 * @returns {Promise<Object>} A promise that resolves with an object containing the passed-in options and a list of
 *                            reference-resolver functions for some given depth (not sure yet, which),
 *                            one for each discovered external reference at that depth.
 */
function findExternalRefs(options) {
    return new Promise(function (res, rej) {

        scanExternalRefs(options)
        .then(function (refs) {
            // Process through each ref cataloged by scanExternalRefs and build a function to resolve it.
            for (let ref in refs) {

                if (!refs[ref].resolved) {
                    let depth = options.resolver.depth;
                    if (depth>0) depth++;
                    options.resolver.actions[depth].push(function () {
                        return resolveExternal(options.openapi, ref, options, function (data, source, options) {
                            if (!refs[ref].resolved) {
                                let external = {};
                                external.context = refs[ref];
                                external.$ref = ref;
                                external.original = clone(data);
                                external.updated = data;
                                external.source = source;
                                options.externals.push(external);
                                refs[ref].resolved = true;
                            }

                            let localOptions = Object.assign({}, options, { source: '',
                                resolver: {actions: options.resolver.actions,
                                depth: options.resolver.actions.length-1, base: options.resolver.base } });
                            if (options.patch && refs[ref].description && !data.description &&
                                (typeof data === 'object')) {
                                data.description = refs[ref].description;
                            }
                            refs[ref].data = data;

                            // sorting $refs by length causes bugs (due to overlapping regions?)
                            let pointers = unique(refs[ref].paths);
                            pointers = pointers.sort(function(a,b){
                                const aComp = (a.startsWith('#/components/') || a.startsWith('#/definitions/'));
                                const bComp = (b.startsWith('#/components/') || b.startsWith('#/definitions/'));
                                if (aComp && !bComp) return -1;
                                if (bComp && !aComp) return +1;
                                return 0;
                            });


                            // a pointer is something that is USING an external ref;
                            // a ref is the actual thing
                            for (let ptr of pointers) {
                                // shared x-ms-examples $refs confuse the fixupRefs heuristic in index.js
                                // if we've already resolved a given reference, then update it to point at the spot we resolved it to.

                                // Discriminator Mapping kludge: strip marker if found and set refType to DISC_MAPPING
                                let refType = RefType.$REF;
                                if (ptr.startsWith(DISC_MAPPING_MARKER)) {
                                    ptr = ptr.substring(DISC_MAPPING_MARKER.length);
                                    refType = RefType.DISC_MAPPING;
                                }

                                if (refs[ref].resolvedAt && (ptr !== refs[ref].resolvedAt) && (ptr.indexOf('x-ms-examples/')<0)) {
                                    if (options.verbose>1) console.warn('Creating pointer to data at', ptr);
                                    let finalResolvedAtValue = refs[ref].resolvedAt + refs[ref].extras[ptr];
                                    let finalOriginalValue = ref + refs[ref].extras[ptr];

                                    // Replace the ref to an external file with the location at which it is resolved.
                                    // Different ref-types have different data models to adjust.
                                    // Also, store the original value in a peer 'x-miro*' property, which will be
                                    // scrubbed on final cleanup.
                                    if (refType === RefType.DISC_MAPPING) {
                                        // This object has multiple keys, each of which is a ref. Adjust the key of interest.
                                        jptr(options.openapi, ptr, finalResolvedAtValue); // resolutionCase:E2 (new object Disc Mapping)
                                        // make a peer to ptr to hold its x-miro value:
                                        const ptrSegments = ptr.split('/');
                                        const discMappingXMiroKey = X_MIRO_FOR_KEY_PREFIX + ptrSegments.pop();
                                        ptrSegments.push(discMappingXMiroKey);
                                        const discMappingObjPath = ptrSegments.join('/');

                                        jptr(options.openapi, discMappingObjPath, finalOriginalValue)
                                    }
                                    else {
                                        // This object only has one ref in it. Adjust its value.
                                        jptr(options.openapi, ptr, { $ref: finalResolvedAtValue, 'x-miro': finalOriginalValue }); // resolutionCase:E1 (new object)
                                    }
                                }
                                // if we haven't resolved the ref; let's try to resolve it
                                else {
                                    const finalPtr = options.hoistResolvedComponents ?
                                      determineHoistedPtr(ptr, ref, options.openapi) :
                                      ptr;

                                    if (refs[ref].resolvedAt) {
                                        // if the previous if failed (due to the x-ms-examples thing); then lets avoid reffing to ourselves
                                        if (options.verbose>1) console.warn('Avoiding circular reference');
                                    }
                                    else {
                                        // then assign the resolvedAt location to the current pointer
                                        refs[ref].resolvedAt = finalPtr;
                                        if (options.verbose>1) console.warn('Creating initial clone of data at', ptr);
                                    }
                                    // then spread the data out at the location of the pointer
                                    let cdata = clone(data);
                                    jptr(options.openapi, finalPtr, cdata); // resolutionCase:F (cloned:yes)

                                    // if we re-routed the destination of the data, update the ptr to point there
                                    if (finalPtr !== ptr) {
                                        jptr(options.openapi, ptr, { '$ref': finalPtr });
                                    }
                                }
                            }
                            // If there are no actions at the current resolver depth, add a new action to find external references.
                            if (options.resolver.actions[localOptions.resolver.depth].length === 0) {
                                //options.resolver.actions[localOptions.resolver.depth].push(function () { return scanExternalRefs(localOptions) });

                                // Add a function to find external references at the current depth.
                                options.resolver.actions[localOptions.resolver.depth].push(function () { return findExternalRefs(localOptions) }); // findExternalRefs calls scanExternalRefs
                            }
                        });
                    });
                }
            }
        })
        .catch(function(ex){
            if (options.verbose) console.warn(ex);
            rej(ex);
        });

        // build a result object that returns back the provided options in a self-named property,
        // and the list of actions to resolve the refs. Then Promise-return it.
        let result = {options:options};
        result.actions = options.resolver.actions[options.resolver.depth];
        res(result);
    });
}

/**
 * Executes an array of functions sequentially, where each function returns a promise.
 *
 * @param {Function[]} funcs - An array of functions that return promises.
 * @returns {Promise} A promise that resolves with an array of results from each function.
 */
const serial = funcs =>
    funcs.reduce((promise, func) =>
        promise.then(result => func().then(Array.prototype.concat.bind(result))), Promise.resolve([]));

/**
 * Recursively resolves external references within an OpenAPI document.
 *
 * @param {Object} options - Options for resolving external references.
 * @param {Object} options.openapi - The OpenAPI document.
 * @param {string} options.source - The source URL or path of the OpenAPI document.
 * @param {Object} options.cache - A cache for storing resolved references.
 * @param {Object} options.externalRefs - A map of external references.
 * @param {boolean} [options.ignoreIOErrors=false] - Whether to ignore I/O errors.
 * @param {boolean} [options.verbose=false] - Whether to log verbose output.
 * @param {boolean} [options.fatal=false] - Whether to throw an error on failure.
 * @param {boolean} [options.promise=false] - Whether to use promises for error handling.
 * @param {Object} options.handlers - Custom handlers for different protocols.
 * @param {Object} options.fetchOptions - Options for the fetch function.
 * @param {Object} options.agent - The agent to use for HTTP requests.
 * @param {boolean} [options.rewriteRefs=true] - Whether to rewrite references.
 * @param {boolean} [options.resolveInternal=false] - Whether to resolve internal references.
 * @param {boolean} [options.preserveMiro=false] - Whether to preserve 'x-miro' properties.
 * @param {Object[]} options.externals - An array to store external references.
 * @param {Object} options.resolver - Resolver options.
 * @param {number} options.resolver.depth - The current depth of the resolver.
 * @param {string} options.resolver.base - The base URL or path for resolving references.
 * @param {Function[][]} options.resolver.actions - An array of arrays of resolver actions.
 * @param {Function} res - The resolve function of the Promise.
 * @param {Function} rej - The reject function of the Promise.
 */
function loopReferences(options, res, rej) {
    options.resolver.actions.push([]);
    findExternalRefs(options)
        .then(function (data) {
            // For each ref-resolver function from findExternalRefs, execute then post-process each execution, at which
            // point recurse down a layer of depth and recursively call back to our parent function, loopReferences
            serial(data.actions)
                .then(function () {
                    if (options.resolver.depth>=options.resolver.actions.length) {
                        console.warn('Ran off the end of resolver actions');
                        return res(true);
                    } else {
                        options.resolver.depth++;
                        if (options.resolver.actions[options.resolver.depth].length) {
                            setTimeout(function () {
                                loopReferences(data.options, res, rej);
                            }, 0);
                        }
                        else {
                            // This is the end of the whole resolving operation. Clean up.

                            if (options.verbose>1) console.warn(common.colour.yellow+'Finished external resolution!',common.colour.normal);
                            if (options.resolveInternal) {
                                if (options.verbose>1) console.warn(common.colour.yellow+'Starting internal resolution!',common.colour.normal);
                                options.openapi = deRef(options.openapi,options.original,{verbose:options.verbose-1});
                                if (options.verbose>1) console.warn(common.colour.yellow+'Finished internal resolution!',common.colour.normal);
                            }
                            // Clean out the x-miro.
                            recurse(options.openapi,{},function(obj,key,state){
                                if (getIfReference(obj, key, state)) {
                                    if (!options.preserveMiro) {
                                        delete obj['x-miro'];
                                        delete obj[X_MIRO_FOR_KEY_PREFIX + key];
                                    }
                                }
                            });
                            res(options);
                        }
                    }
                })
                .catch(function (ex) {
                    if (options.verbose) console.warn(ex);
                    rej(ex);
                });
        })
        .catch(function(ex){
            if (options.verbose) console.warn(ex);
            rej(ex);
        });
}

function setupOptions(options) {
    if (!options.cache) options.cache = {};
    if (!options.fetch) options.fetch = fetch;

    if (options.source) {
        let srcUrl = url.parse(options.source);
        if (!srcUrl.protocol || srcUrl.protocol.length <= 2) { // windows drive-letters
            options.source = path.resolve(options.source);
        }
    }

    if (!options.externals) options.externals = [];
    if (!options.externalRefs) options.externalRefs = {};
    options.rewriteRefs = true;
    options.resolver = {};
    options.resolver.depth = 0;
    options.resolver.base = options.source;
    options.resolver.actions = [[]];
}

/** compatibility function for swagger2openapi */
function optionalResolve(options) {
    setupOptions(options);
    return new Promise(function (res, rej) {
        if (options.resolve)
            loopReferences(options, res, rej)
        else
            res(options);
    });
}

/**
 * Resolves all external references within an OpenAPI document.
 *
 * @param {Object} openapi - The OpenAPI document to resolve.
 * @param {string} source - The source URL or path of the OpenAPI document.
 * @param {Object} [options] - Options for resolving the OpenAPI document.
 * @param {Object} [options.cache] - A cache for storing resolved references.
 * @param {Function} [options.fetch] - The fetch function to use for HTTP requests.
 * @param {Object} [options.externalRefs] - A map of external references.
 * @param {boolean} [options.ignoreIOErrors=false] - Whether to ignore I/O errors.
 * @param {boolean} [options.verbose=false] - Whether to log verbose output.
 * @param {boolean} [options.fatal=false] - Whether to throw an error on failure.
 * @param {boolean} [options.promise=false] - Whether to use promises for error handling.
 * @param {Object} [options.handlers] - Custom handlers for different protocols.
 * @param {Object} [options.fetchOptions] - Options for the fetch function.
 * @param {Object} [options.agent] - The agent to use for HTTP requests.
 * @param {boolean} [options.rewriteRefs=true] - Whether to rewrite references.
 * @param {boolean} [options.resolveInternal=false] - Whether to resolve internal references.
 * @param {boolean} [options.preserveMiro=false] - Whether to preserve 'x-miro' properties.
 * @param {Object[]} [options.externals] - An array to store external references.
 * @returns {Promise<Object>} A promise that resolves with the options object containing resolved references.
 */
function resolve(openapi,source,options) {
    if (!options) options = {};
    options.openapi = openapi;
    options.source = source;
    options.resolve = true;
    setupOptions(options);
    return new Promise(function (res, rej) {
        loopReferences(options, res, rej)
    });
}

module.exports = {
    optionalResolve: optionalResolve,
    resolve: resolve
};
