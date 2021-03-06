'use strict';

var fs = require('fs');
var Mustache = require('mustache');
var beautify = require('js-beautify').js_beautify;
var lint = require('jshint').JSHINT;
var _ = require('lodash');
var typeConversion = require('./typeConversion');

var getPathToMethodName = function(httpMethod, path){
    if(path === '/' || path === '') {
        return httpMethod;
    }

    // clean url path for requests ending with '/'
    var cleanPath = path;
    if( cleanPath.indexOf('/', cleanPath.length - 1) !== -1 ) {
        cleanPath = cleanPath.substring(0, cleanPath.length - 1);
    }

    var segments = cleanPath.split('/').slice(1);
    segments = _.transform(segments, function (result, segment) {
        if (segment[0] === '{' && segment[segment.length - 1] === '}') {
            segment = 'By' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
        }
        result.push(segment);
    });
    var result = segments.join();

    return httpMethod.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

var getViewForSwagger2 = function(opts, type){
    var swagger = opts.swagger;
    var authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLIK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
    var data = {
        isNode: type === 'node',
        description: swagger.info.description,
        isSecure: swagger.securityDefinitions !== undefined,
        moduleName: opts.moduleName,
        className: opts.className,
        domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath) ? swagger.schemes[0] + '://' + swagger.host + swagger.basePath : '',
        methods: [],
        definitions: []
    };

    _.forEach(swagger.paths, function(api, path){
        var globalParams = [];
        /**
         * @param {Object} op - meta data for the request
         * @param {string} httpMethod - HTTP method name - eg: 'get', 'post', 'put', 'delete'
         */
        _.forEach(api, function(op, httpMethod){
            if(httpMethod.toLowerCase() === 'parameters') {
                globalParams = op;
            }
        });
        _.forEach(api, function(op, httpMethod){
            if(authorizedMethods.indexOf(httpMethod.toUpperCase()) === -1) {
                return;
            }
            var method = {
                path: path,
                className: opts.className,
                methodName: op['x-swagger-js-method-name'] ? op['x-swagger-js-method-name'] : (op.operationId ? op.operationId : getPathToMethodName(httpMethod, path)),
                method: httpMethod.toUpperCase(),
                isGET: httpMethod.toUpperCase() === 'GET',
                summary: op.description,
                isSecure: op.security !== undefined,
                parameters: []
            };
            var params = [];
            if(_.isArray(op.parameters)) {
                params = op.parameters;
            }
            params = params.concat(globalParams);
            _.chain(params).forEach(function(parameter) {
                // Ignore headers which are injected by proxies & app servers
                // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
                if (parameter['x-proxy-header'] && !data.isNode) {
                    return;
                }
                if (_.isString(parameter.$ref)) {
                    var segments = parameter.$ref.split('/');
                    parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2] ];
                }

                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.in === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.in === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.in === 'query'){
                    if(parameter.pattern){
                        parameter.isPatternType = true;
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.in === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.in === 'formData'){
                    parameter.isFormParameter = true;
                }

                // extract parameter type
                _.merge(parameter, typeConversion.convertType(parameter));

                method.parameters.push(parameter);
            });

            // extract response type for 200 response, if present
            if (_.isObject(op.responses) && _.isObject(op.responses['200'])) {
                var resp = op.responses['200'];
                if (resp.schema) {
                    method.responseType = typeConversion.convertType(resp);
                }
            }

            data.methods.push(method);
        });
    });

    // read definitions and their types
    _.forEach(swagger.definitions, function(swaggerType, name) {
        if (swaggerType.type === undefined) {
            // sometimes the 'type' property seems to be missing. In this case, we assume 'object'
            swaggerType.type = 'object';
        }
        var tsType = typeConversion.convertType(swaggerType);
        tsType.name = name;
        data.definitions.push(tsType);
    });

    return data;
};

var getViewForSwagger1 = function(opts, type){
    var swagger = opts.swagger;
    var data = {
        isNode: type === 'node',
        description: swagger.description,
        moduleName: opts.moduleName,
        className: opts.className,
        domain: swagger.basePath ? swagger.basePath : '',
        methods: []
    };
    swagger.apis.forEach(function(api){
        api.operations.forEach(function(op){
            var method = {
                path: api.path,
                className: opts.className,
                methodName: op.nickname,
                method: op.method,
                isGET: op.method === 'GET',
                summary: op.summary,
                parameters: op.parameters
            };
            op.parameters = op.parameters ? op.parameters : [];
            op.parameters.forEach(function(parameter) {
                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.paramType === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.paramType === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.paramType === 'query'){
                    if(parameter.pattern){
                        parameter.isPatternType = true;
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.paramType === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.paramType === 'form'){
                    parameter.isFormParameter = true;
                }
            });
            data.methods.push(method);
        });
    });
    return data;
};

var getJSCode = function(opts, type) {
    var tpl, method, request, tpltypes, typedefs;
    // For Swagger Specification version 2.0 value of field 'swagger' must be a string '2.0'
    var data = opts.swagger.swagger === '2.0' ? getViewForSwagger2(opts, type) : getViewForSwagger1(opts, type);
    if(type === 'custom') {
        if(!_.isObject(opts.template) || !_.isString(opts.template.class)  || !_.isString(opts.template.method) || !_.isString(opts.template.request)) {
            throw new Error('Unprovided custom template. Please use the following template: template: { class: "...", method: "...", request: "..." }');
        }
        tpl = opts.template.class;
        method = opts.template.method;
        request = opts.template.request;
    }
    else if( type == 'es6') {
        tpl = fs.readFileSync(__dirname + '/../templates/node-' + type + '-class.mustache', 'utf-8');
        method = fs.readFileSync(__dirname + '/../templates/node-es6-method.mustache', 'utf-8');
        tpltypes = fs.readFileSync(__dirname + '/../templates/type.mustache', 'utf-8');
        typedefs = fs.readFileSync(__dirname + '/../templates/typedef.mustache', 'utf-8');
        request = fs.readFileSync(__dirname + '/../templates/node-' + type + '-request.mustache', 'utf-8');
    }
    else {
        tpl = fs.readFileSync(__dirname + '/../templates/' + type + '-class.mustache', 'utf-8');
        method = fs.readFileSync(__dirname + '/../templates/method.mustache', 'utf-8');
        request = fs.readFileSync(__dirname + '/../templates/' + type + '-request.mustache', 'utf-8');
    }

    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }

    var source = Mustache.render(tpl, data, {
        method: method,
        request: request,
        type: tpltypes
    });
    var lintOptions = {
        node: type === 'node' || type === 'custom',
        browser: type === 'angular' || type === 'custom',
        undef: true,
        strict: true,
        trailing: true,
        smarttabs: true
    };
    if (opts.esnext) {
        lintOptions.esnext = true;
    }
    lint(source, lintOptions);
    lint.errors.forEach(function(error){
        if(error.code[0] === 'E') {
            throw new Error(lint.errors[0].reason + ' in ' + lint.errors[0].evidence);
        }
    });
    return beautify(source, { indent_size: 4, max_preserve_newlines: 2 });
};

var getTypeScriptDefinition = function(opts, type, resultTypeFn){
    if (opts.swagger.swagger !== '2.0') {
        throw 'Typescript is only supported for Swagger 2.0 specs.';
    }

    var data = opts.swagger.swagger === '2.0' ? getViewForSwagger2(opts) : getViewForSwagger1(opts);
    var tpl = fs.readFileSync(__dirname + '/../templates/typedef.mustache', 'utf-8');
    var typeTpl = fs.readFileSync(__dirname + '/../templates/type.mustache', 'utf-8');
    data.resultFn = function () {
        return function (tmpl, render) {
            return resultTypeFn(render(tmpl));
        };
    };

    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }
    data.imports = opts.imports;
    data.isNode = type === 'node';
    data.isTypeScript = type === 'typescript';
    data.isAngular = type === 'angular';

    var source = Mustache.render(tpl, data, {type: typeTpl});
    return source;
};

exports.CodeGen = {
    getAngularCode: function(opts){
        return getJSCode(opts, 'angular');
    },
    getNodeCode: function(opts){
        return getJSCode(opts, 'node');
    },
    getES6Code: function(opts) {
        opts.esnext = true;
        return getJSCode(opts, 'es6');
    },
    getES6CodeTypes: function(opts){
        opts.esnext = true;
        return getJSCode(opts, 'es6');
    },
    getCustomCode: function(opts){
        return getJSCode(opts, 'custom');
    },
    getNodeTypeScriptDefinition: function(opts){
        return getTypeScriptDefinition(opts, function (resultType) {
            return 'Q.Promise<{response: http.IncomingMessage, body: ' + resultType + '}>';
        });
    },
    getTypeScriptDefinition: function(opts){
        opts.imports = [{name: 'Q', path: 'q'}];  // requires Q as a dependency.
        return getTypeScriptDefinition(opts, 'typescript', function (resultType) {
            return 'Q.Promise<{response: http.IncomingMessage, body: ' + resultType + '}>';
        });
    },
    getAngularTypeScriptDefinition: function(opts){
        return getTypeScriptDefinition(opts, function (resultType) {
            return 'ng.IPromise<' + resultType + '>';
        });
    }
};
