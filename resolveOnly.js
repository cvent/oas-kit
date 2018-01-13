#!/usr/bin/env node

const fs = require('fs');
const util = require('util');
const resolver = require('./resolver.js');
const yaml = require('js-yaml');
const fetch = require('node-fetch');

// TODO yargs

let filespec = process.argv[2];

let options = {resolve: true};

options.origin = filespec;
options.source = filespec;
options.verbose = true;
options.externals = [];
options.externalRefs = {};
options.rewriteRefs = false;
options.cache = [];
options.status ='undefined';

function main(str){
    options.openapi = yaml.safeLoad(str,{json:true});
    resolver.resolve(options)
    .then(function(){
        options.status = 'resolved';
        //fs.writeFileSync('./resolved.json',JSON.stringify(options.openapi,null,2),'utf8');
        fs.writeFileSync('./resolved.yaml',yaml.safeDump(options.openapi,{lineWidth:-1}),'utf8');
    })
    .catch(function(err){
        options.status = 'rejected';
        console.warn(err);
    });
}

if (filespec.startsWith('http')) {
    console.log('GET ' + filespec);
    fetch(filespec, {agent:options.agent}).then(function (res) {
        if (res.status !== 200) throw new Error(`Received status code ${res.status}`);
        return res.text();
    }).then(function (body) {
        main(body);
    }).catch(function (err) {
        console.warn(err);
    });
}
else {
    fs.readFile(filespec,'utf8',function(err,data){
        if (err) {
            console.warn(err);
        }
        else {
            main(data);
        }
    });
}

process.on('exit',function(){
    console.log(util.inspect(options.openapi,{depth:null}));
    console.log(options.status);
});
