const request = require('request');
const cheerio = require('cheerio');
const async = require('async');
const fs = require('fs');
const GenerateSchema = require('generate-schema');
const minimist = require('minimist');

const args = minimist(process.argv.slice(2));

const schema_dir = args['schema_dir'];

function cacheGetOrAdd(url, cb) {
  const cacheKey = url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const cacheFile = `./cache/${cacheKey}`;

  fs.readFile(cacheFile, (err, data) => {
    if (err) {
      request(url, (err, response, html) => {
        if (err) {
          cb(err);
        } else {
          fs.writeFile(cacheFile, html, (_) => {
            cb(null, response, html);
          });
        }
      });
    } else {
      cb(null, null, data);
    }
  });
}

function sanitizeResponse(methodName, response) {
  // remove dangling commas
  response = response.replace(/,\s*(}|])/mg, "$1");
  // add missing commas between objects
  response = response.replace(/}\s*{/mg, "},{");
  // add missing commas between arrays
  response = response.replace(/]\s*\[/mg, "],[");
  // add missing commas after end of line
  response = response.replace(/\"\s+\"/mg, "\",\"");
  response = response.replace(/e\s+\"/mg, "e,\"");
  response = response.replace(/}\s+\"/mg, "},\"");
  response = response.replace(/]\s+\"/mg, "],\"");
  // replace { ... } with {}
  response = response.replace(/\{\s*(\.+|…)\s*\}/mg, () => {
    console.log(`Replacing ... in object fields in response for ${methodName}`);
    return "{}";
  });
  // replace [ ... ] with []
  response = response.replace(/\[\s*(\.+|…)\s*]/mg, () => {
    console.log(`Replacing ... as array in response for ${methodName}`);
    return "[]";
  });
  // replace , ... } with }
  response = response.replace(/,\s*(\.+|…)\s*}/mg, () => {
    console.log(`Replacing ... in object fields in response for ${methodName}`);
    return "}";
  });
  // replace { ... with {
  response = response.replace(/{\s*(\.+|…)\s*/m, () => {
    console.log(`Replacing ... in object fields in response for ${methodName}`);
    return "{";
  });
  // replace , ... ] with ]
  response = response.replace(/,\s*(\.+|…)?\s*]/mg, "]");
  // replace thread_info using [] instead of {}
  response = response.replace(/"thread_info": \[((.|\s)+?)\]/mg, "\"thread_info\": {$1}");

  // remove dangling comma at end
  response = response.trim();
  if(response[response.length - 1] === ',') {
    response = response.substring(0, response.length - 1);
  }

  return response.trim() ? JSON.stringify(JSON.parse(response)) : "";
}

function schema(path, injectedSchema) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }
    section.properties[parts[parts.length - 1]] = injectedSchema;
    return newSchema;
  }
}

function replaceWith(newSchema) {
  return (_) => newSchema;
}

// function navigateSchema(path, schema, transformer) {
//   const newSchema = schema;
//   const parts = path.split('.');
//   let section = newSchema;
//   for(let i = 0; i < parts.length - 1; i++) {
//     const part = parts[i];
//     section = part.endsWith("[]")
//       ? section.properties[part.substring(0, part.length - 2)].items
//       : section.properties[part];
//   }

//   const lastPart = parts[parts.length - 1];
//   if (lastPart.endsWith("[]")) {
//     transformer(section.properties[lastPart.substring(0, lastPart.length - 2)].items)
//   } else {
//     transformer(section.properties[lastPart])
//   }
// }

function setRequired(path, reqFields) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }

    // this only works when the path ends with []. fix me
    const lastPart = parts[parts.length - 1];
    section.properties[lastPart.substring(0, lastPart.length - 2)].items.required = reqFields;
    return newSchema;
  };
}

function schemaRef(path, refSchema) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }
    let title = refSchema.name;
    section.properties[parts[parts.length - 1]] = { "$ref": `../objects/${title}.json` };
    return newSchema;
  }
}

function schemaList(path, injectedSchema) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }
    section.properties[parts[parts.length - 1]].type = "array";
    section.properties[parts[parts.length - 1]].items = injectedSchema;
    return newSchema;
  }
}

function schemaListRef(path, refSchema) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }
    let title = refSchema.name;
    section.properties[parts[parts.length - 1]].items = { "$ref": `../objects/${title}.json` };
    return newSchema;
  }
}

function treatAsMap(path, props) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for(let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      section = part.endsWith("[]")
        ? section.properties[part.substring(0, part.length - 2)].items
        : section.properties[part];
    }
    section.properties[parts[parts.length - 1]].type = "object";
    section.properties[parts[parts.length - 1]].patternProperties = {
      "^.+$": props || section.properties[Object.keys(section.properties)[0]]
    };
    section.properties[parts[parts.length - 1]].properties = {};
    section.properties[parts[parts.length - 1]].additionalProperties = false;
    return newSchema;
  };
}

function makeRef(name, schema) {
  return {
    "name": name,
    "schema": schema
  };
}

const BOT_SCHEMA = makeRef("bot", require(`${schema_dir}/objects/bot.json`));
const IM_SCHEMA = makeRef("im", require(`${schema_dir}/objects/im.json`));
const MPIM_SCHEMA = makeRef("mpim", require(`${schema_dir}/objects/mpim.json`));
const USER_SCHEMA = makeRef("user", require(`${schema_dir}/objects/user.json`));
const CHANNEL_SCHEMA = makeRef("channel", require(`${schema_dir}/objects/channel.json`));
const GROUP_SCHEMA = makeRef("group", require(`${schema_dir}/objects/group.json`));
const FILE_COMMENT_SCHEMA = makeRef("file_comment", require(`${schema_dir}/objects/file_comment.json`));
const FILE_SCHEMA = makeRef("file", require(`${schema_dir}/objects/file.json`));
// assumes that channels and groups are lists of strings
const USERGROUP_SCHEMA = makeRef("usergroup", require(`${schema_dir}/objects/usergroup.json`));
const MESSAGE_SCHEMA = makeRef("message", require(`${schema_dir}/objects/message.json`));
const PAGING_SCHEMA = makeRef("paging", require(`${schema_dir}/objects/paging.json`));
const TEAM_SCHEMA = makeRef("team", require(`${schema_dir}/objects/team.json`));
const THREAD_INFO_SCHEMA = makeRef("thread_info", require(`${schema_dir}/objects/thread_info.json`));
const REMINDER_SCHEMA = makeRef("reminder", require(`${schema_dir}/objects/reminder.json`));
const USER_PROFILE_SCHEMA = makeRef("user_profile", require(`${schema_dir}/objects/user_profile.json`));

const SCHEMA_OVERRIDES = new Map([
  ["api.test", [treatAsMap("args")]],
  ["channels.create", [schemaRef("channel", CHANNEL_SCHEMA)]],
  ["channels.history", [schemaListRef("messages", MESSAGE_SCHEMA)]],
  ["channels.info", [schemaRef("channel", CHANNEL_SCHEMA)]],
  ["channels.invite", [schemaRef("channel", CHANNEL_SCHEMA)]],
  ["channels.join", [schemaRef("channel", CHANNEL_SCHEMA)]],
  ["channels.list", [schemaListRef("channels", CHANNEL_SCHEMA)]],
  ["channels.replies", [
    schemaListRef("messages", MESSAGE_SCHEMA),
    schemaRef("thread_info", THREAD_INFO_SCHEMA),
  ]],
  ["chat.postMessage", [schemaRef("message", MESSAGE_SCHEMA)]],
  ["dnd.teamInfo", [treatAsMap("users")]],
  ["emoji.list", [treatAsMap("emoji")]],
  ["files.info", [
    schemaRef("file", FILE_SCHEMA),
    schemaListRef("comments", FILE_COMMENT_SCHEMA),
    schemaRef("paging", PAGING_SCHEMA),
  ]],
  ["files.list", [
    schemaListRef("files", FILE_SCHEMA),
    schemaRef("paging", PAGING_SCHEMA)
  ]],
  ["files.revokePublicURL", [schemaRef("file", FILE_SCHEMA)]],
  ["files.sharedPublicURL", [schemaRef("file", FILE_SCHEMA)]],
  ["files.upload", [schemaRef("file", FILE_SCHEMA)]],
  ["files.comments.add", [schemaRef("comment", FILE_COMMENT_SCHEMA)]],
  ["files.comments.edit", [schemaRef("comment", FILE_COMMENT_SCHEMA)]],
  ["groups.create", [schemaRef("group", GROUP_SCHEMA)]],
  ["groups.createChild", [schemaRef("group", GROUP_SCHEMA)]],
  ["groups.history", [schemaListRef("messages", MESSAGE_SCHEMA)]],
  ["groups.info", [schemaRef("group", GROUP_SCHEMA)]],
  ["groups.invite", [schemaRef("group", GROUP_SCHEMA)]],
  ["groups.list", [schemaListRef("groups", GROUP_SCHEMA)]],
  ["groups.replies", [
    schemaListRef("messages", MESSAGE_SCHEMA),
    schemaRef("thread_info", THREAD_INFO_SCHEMA),
  ]],
  ["im.list", [schemaListRef("ims", IM_SCHEMA)]],
  ["im.history", [schemaListRef("messages", MESSAGE_SCHEMA)]],
  ["im.open", [schemaRef("channel", IM_SCHEMA)]],
  ["im.replies", [
    schemaListRef("messages", MESSAGE_SCHEMA),
    schemaRef("thread_info", THREAD_INFO_SCHEMA),
  ]],
  ["mpim.list", [schemaListRef("groups", MPIM_SCHEMA)]],
  ["mpim.history", [schemaListRef("messages", MESSAGE_SCHEMA)]],
  ["mpim.open", [schemaRef("group", MPIM_SCHEMA)]],
  ["mpim.replies", [
    schemaListRef("messages", MESSAGE_SCHEMA),
    schemaRef("thread_info", THREAD_INFO_SCHEMA),
  ]],
  ["pins.list", [schemaList("items", {
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "channel": { "type": "string" },
          "message": { "$ref": "../objects/message.json" },
          "created": { "type": "number" },
          "created_by": { "type": "string" }
        },
        "id": "message",
        "required": [
          "type",
          "channel",
          "message"
        ]
      },
      {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "file": { "$ref": "../objects/file.json" },
          "created": { "type": "number" },
          "created_by": { "type": "string" }
        },
        "id": "file",
        "required": [
          "type",
          "file"
        ]
      },
      {
        "type": "object",
        "properties": {
          "type": { "type": "string" },
          "file": { "$ref": "../objects/file.json" },
          "comment": { "$ref": "../objects/file_comment.json" },
          "created": { "type": "number" },
          "created_by": { "type": "string" }
        },
        "id": "fileComment",
        "required": [
          "type",
          "file",
          "comment"
        ]
      }
    ]
  })]],
  ["reactions.get", [replaceWith({
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "ok": { "type": "boolean" },
          "error": { "type": "string" },
          "type": { "type": "string" },
          "channel": { "type": "string" },
          "message": { "$ref": "../objects/message.json" },
        },
        "id": "message",
        "required": [
          "ok",
          "type",
          "channel",
          "message"
        ]
      },
      {
        "type": "object",
        "properties": {
          "ok": { "type": "boolean" },
          "error": { "type": "string" },
          "type": { "type": "string" },
          "file": { "$ref": "../objects/file.json" }
        },
        "id": "file",
        "required": [
          "ok",
          "type",
          "file"
        ]
      },
      {
        "type": "object",
        "properties": {
          "ok": { "type": "boolean" },
          "error": { "type": "string" },
          "type": { "type": "string" },
          "file": { "$ref": "../objects/file.json" },
          "comment": { "$ref": "../objects/file_comment.json" }
        },
        "id": "fileComment",
        "required": [
          "ok",
          "type",
          "file",
          "comment"
        ]
      }
    ]
  })]],
  ["reactions.list", [
    schemaList("items", {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "channel": { "type": "string" },
            "message": { "$ref": "../objects/message.json" },
          },
          "id": "message",
          "required": [
            "type",
            "channel",
            "message"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "file": { "$ref": "../objects/file.json" }
          },
          "id": "file",
          "required": [
            "type",
            "file"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "file": { "$ref": "../objects/file.json" },
            "comment": { "$ref": "../objects/file_comment.json" }
          },
          "id": "fileComment",
          "required": [
            "type",
            "file",
            "comment"
          ]
        }
      ]
    }),
    schemaRef("paging", PAGING_SCHEMA),
  ]],
  ["reminders.add", [schemaRef("reminder", REMINDER_SCHEMA)]],
  ["reminders.info", [schemaRef("reminder", REMINDER_SCHEMA)]],
  ["reminders.list", [schemaListRef("reminders", REMINDER_SCHEMA)]],
  ["rtm.start", [
    schemaListRef("channels", CHANNEL_SCHEMA),
    schemaListRef("groups", GROUP_SCHEMA),
    schemaListRef("ims", IM_SCHEMA),
    schemaListRef("mpims", MPIM_SCHEMA),
    schemaListRef("users", USER_SCHEMA),
    schemaListRef("bots", BOT_SCHEMA),
    schemaRef("self", USER_SCHEMA),
    schemaRef("team", TEAM_SCHEMA),
  ]],
  ["search.all", [
    schema("files", {
      "$schema": "http://json-schema.org/draft-04/schema#",
      "type": "object",
      "properties": {
        "matches": {
          "type": "array",
          "items": { "$ref": "../objects/file.json" }
        },
        "paging": { "$ref": "../objects/paging.json" }
      },
      "id": "files",
      "required": [
        "matches",
        "paging"
      ]
    }),
    schema("messages", {
      "$schema": "http://json-schema.org/draft-04/schema#",
      "type": "object",
      "properties": {
        "matches": {
          "type": "array",
          "items": { "$ref": "../objects/message.json" }
        },
        "paging": { "$ref": "../objects/paging.json" }
      },
      "id": "messages",
      "required": [
        "matches",
        "paging"
      ]
    }),
  ]],
  ["search.files", [
    schemaListRef("files.matches", FILE_SCHEMA),
    schemaRef("files.paging", PAGING_SCHEMA),
    schema("files.total", {"type": "integer"})
  ]],
  ["search.messages", [
    schemaListRef("messages.matches", MESSAGE_SCHEMA),
    schemaRef("messages.paging", PAGING_SCHEMA),
    schema("messages.total", {"type": "integer"})
  ]],
  ["stars.list", [
    schemaList("items", {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "channel": { "type": "string" },
            "message": { "$ref": "../objects/message.json" }
          },
          "id": "message",
          "required": [
            "type",
            "channel",
            "message"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "file": { "$ref": "../objects/file.json" }
          },
          "id": "file",
          "required": [
            "type",
            "file"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "file": { "$ref": "../objects/file.json" },
            "comment": { "$ref": "../objects/file_comment.json" }
          },
          "id": "fileComment",
          "required": [
            "type",
            "file",
            "comment"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "channel": { "type": "string" }
          },
          "id": "channel",
          "required": [
            "type",
            "channel"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "channel": { "type": "string" }
          },
          "id": "im",
          "required": [
            "type",
            "channel"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "group": { "type": "string" }
          },
          "id": "group",
          "required": [
            "type",
            "group"
          ]
        }
      ]
    }),
    schemaRef("paging", PAGING_SCHEMA),
  ]],
  ["team.accessLogs", [
    schemaRef("paging", PAGING_SCHEMA),
    schema("logins[].count", {"type": "integer"}),
    setRequired("logins[]", undefined)
  ]],
  ["team.billableInfo", [treatAsMap("billable_info")]],
  ["team.integrationLogs", [
    schemaRef("paging", PAGING_SCHEMA),
    setRequired("logs[]", undefined),
  ]],
  ["team.info", [schemaRef("team", TEAM_SCHEMA)]],
  ["team.profile.get", [
    treatAsMap("profile.fields[].options", {"type": "string"}),
    schemaList("profile.fields[].possible_values", {"type": "string"}),
    schema("profile.fields[].is_hidden", {"type": "boolean"}),
    schema("profile.fields[].ordering", {"type": "integer"}),
    setRequired("profile.fields[]", undefined)
  ]],
  ["usergroups.create", [schemaRef("usergroup", USERGROUP_SCHEMA)]],
  ["usergroups.disable", [schemaRef("usergroup", USERGROUP_SCHEMA)]],
  ["usergroups.enable", [schemaRef("usergroup", USERGROUP_SCHEMA)]],
  ["usergroups.list", [schemaListRef("usergroups", USERGROUP_SCHEMA)]],
  ["usergroups.update", [schemaRef("usergroup", USERGROUP_SCHEMA)]],
  ["usergroups.users.update", [schemaRef("usergroup", USERGROUP_SCHEMA)]],
  ["users.identity", [
    schemaRef("user", USER_SCHEMA),
    schemaRef("team", TEAM_SCHEMA),
  ]],
  ["users.info", [schemaRef("user", USER_SCHEMA)]],
  ["users.list", [schemaListRef("members", USER_SCHEMA)]],
  ["users.profile.get", [schemaRef("profile", USER_PROFILE_SCHEMA)]],
  ["users.profile.set", [schemaRef("profile", USER_PROFILE_SCHEMA)]],
]);

function parseResponseToSchema(methodName, response) {
  if (response.trim().length === 0) {
    console.log(`Empty response for ${methodName}`);
    return {};
  }

  try {
    let schema = GenerateSchema.json(JSON.parse(response));
    schema = (SCHEMA_OVERRIDES.get(methodName) || []).reduce((s, fn) => fn(s), schema);
    if (schema.properties && schema.properties.ok) {
      if (!schema.required) {
        schema.required = [];
      }
      if (!schema.required.includes("ok")) {
        schema.required.push("ok");
      }
      if (!schema.properties.error) {
        schema.properties.error = { "type": "string" };
      }
    }
    return schema;
  } catch( e ) {
    console.log(`Failed to parse response object for ${methodName}. ${e}`);
    return {};
  }
}

const KNOWN_PARAM_TYPES = new Map([
  ["channels.rename", new Map([
    ["name", "string"]
  ])],
  ["channels.create", new Map([
    ["name", "string"]
  ])],
  ["channels.history", new Map([
    ["inclusive", "boolean"],
    ["unreads", "boolean"]
  ])],
  ["files.delete", new Map([
    ["file", "file_id"]
  ])],
  ["reactions.get", new Map([
    ["full", "boolean"]
  ])]
]);

function getParamTypeFromExample(method, name, example) {
  if (example === "xxxx-xxxxxxxxx-xxxx") {
    return "auth_token";
  } else if (example === "true" || example === "false") {
    return "boolean";
  } else if (example === "0" || example === "1") {
    console.log(`Marking ${method} param ${name} as boolean because it was ${example}`)
    return "boolean";
  } else if (/^\d{10}\.\d{6}$/.test(example)) {
    return "timestamp";
  } else if (/^\d+$/.test(example)) {
    return "integer";
  } else if (/^(U|W)\d+$/.test(example)) {
    return "user_id";
  } else if (/^C\d+$/.test(example)) {
    return "channel_id";
  } else if (/^F\d+$/.test(example)) {
    return "file_id";
  } else if (/^Fc\d+$/.test(example)) {
    return "file_comment_id";
  } else if (/^D\d+$/.test(example)) {
    return "im_id";
  } else if (/^G\d+$/.test(example)) {
    return "group_id";
  } else if (/^B\d+$/.test(example)) {
    return "bot_id";
  } else if (/^S(\d|\w)+$/.test(example)) {
    return "usergroup_id";
  } else if (/^Rm\d+$/.test(example)) {
    return "reminder_id";
  }

  const known_value = KNOWN_PARAM_TYPES.has(method)
    ? KNOWN_PARAM_TYPES.get(method).get(name)
    : null;
  
  if (known_value !== null) {
    return known_value;
  } else {
    console.log(`Marking ${method} param ${name} as string because it was "${example}"`)
    return "string";
  }
}

function parseSlackMethod(methodName, description, cb) {
  const url = `https://api.slack.com/methods/${methodName}`;
  cacheGetOrAdd(url, (err, res, html) => {
    const $$ = cheerio.load(html);

    const params = $$('h2:contains("Arguments")').nextAll('table.arguments').first().find('tr').slice(1).map((i, arg) => {
      const paramName = $$(arg).children().eq(0).text();
      return {
        name: paramName,
        type: getParamTypeFromExample(methodName, paramName, $$(arg).children().eq(1).text()),
        optional: $$(arg).children().eq(2).text().includes("Optional"),
        description: $$(arg).children().eq(3).text().trim()
      };
    }).get();

    const response = $$('h2:contains("Response")').nextAll('pre').first().text();

    const errors = $$('h2:contains("Errors")').nextAll('table.arguments').first().find('tr').slice(1).map((i, arg) => {
      return {
        name: $$(arg).children().eq(0).text().trim(),
        description: $$(arg).children().eq(1).text().trim()
      };
    }).get();

    cb(null, {
      name: methodName.trim(),
      description: description.trim() || null,
      documentationUrl: url.trim() || null,
      params: params,
      response: {
        sample: response,
        schema: response,
        errors: errors
      }
    });
  });
}

function parseSlackApi(cb) {
  cacheGetOrAdd("https://api.slack.com/methods", (err, response, html) => {
    if (err) {
      throw "Could not load main Slack API documentation.";
    }

    const $ = cheerio.load(html);

    const sections = $('h1:contains("API Methods")').next('div').find('h2');

    async.mapLimit(sections, 3, (elem, done) => {
      const moduleName = $(elem).text();
      const moduleDesc = $(elem).next('p').text();
      const methodElems = $($(elem).nextAll('table')[0]).find('a[href^="/methods"]');

      async.map(methodElems, (link, done) => {
        const methodName = $(link).text();
        const description = $($(link).parent().parent().children('td')[1]).text();

        parseSlackMethod(methodName, description, done);
      }, (err, results) => {
        done(null, {
          name: moduleName.trim(),
          description: moduleDesc.trim(),
          methods: results
        });
      });
    }, (err, results) => {
      cb(results);
    });
  });
}

function parseMessages(done) {
  cacheGetOrAdd("https://api.slack.com/events/message", (err, response, html) => {
    if (err) {
      return done("Could not load message documentation. " + err);
    }

    const $ = cheerio.load(html);

    const rows = $('.card > table').find('tr').slice(1);

    async.mapLimit(rows, 3, (row, done) => {
      const name = $(row).children().eq(0).text();
      const description = $(row).children().eq(1).text().trim();

      cacheGetOrAdd("https://api.slack.com/events/message/" + name, (err, response, html) => {
        if (err) {
          return done(`Could not load message:${name} documentation. ` + err);
        }

        const $$ = cheerio.load(html);

        const sample = $$('pre');
        if (sample.length > 1) {
          console.log(`Saw more than one sample for message:${name}`)
        }

        done(null, {
          name: name,
          description: description,
          sample: sample.first().text()
        });
      });
    }, done);
  });
}

async.parallel([
  (cb) => {
    parseSlackApi((modules) => {
      modules.forEach(mod => {
        if (mod.name === "chat") {
          mod.methods.find(method => method.name === "chat.update").response.sample 
            = '{ "ok": true, "channel": "C024BE91L", "ts": "1401383885.000061", "text": "Updated Text" }';
        }
        if (mod.name === "files") {
          mod.methods.find(method => method.name === "files.sharedPublicURL").response.sample = '{"ok":true,"file":{"id":"F2147483862","timestamp":1356032811,"name":"file.htm","title":"My HTML file","mimetype":"text/plain","filetype":"text","pretty_type":"Text","user":"U2147483697","mode":"hosted","editable":true,"is_external":false,"external_type":"","size":12345,"url":"https://slack-files.com/files-pub/T024BE7LD-F024BERPE-09acb6/1.png","url_download":"https://slack-files.com/files-pub/T024BE7LD-F024BERPE-09acb6/download/1.png","url_private":"https://slack.com/files-pri/T024BE7LD-F024BERPE/1.png","url_private_download":"https://slack.com/files-pri/T024BE7LD-F024BERPE/download/1.png","thumb_64":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_64.png","thumb_80":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_80.png","thumb_360":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_360.png","thumb_360_gif":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_360.gif","thumb_360_w":100,"thumb_360_h":100,"permalink":"https://tinyspeck.slack.com/files/cal/F024BERPE/1.png","permalink_public":"https://slack-files.com/T024BE7LD-F024BERPE-8004f909b1","edit_link":"https://tinyspeck.slack.com/files/cal/F024BERPE/1.png/edit","preview":"&lt;!DOCTYPE html&gt;\\n&lt;html&gt;\\n&lt;meta charset=\'utf-8\'&gt;","preview_highlight":"&lt;div class=\\"sssh-code\\"&gt;&lt;div class=\\"sssh-line\\"&gt;&lt;pre&gt;&lt;!DOCTYPE html","lines":123,"lines_more":118,"is_public":false,"public_url_shared":false,"channels":["C024BE7LT"],"groups":["G12345"],"initial_comment":{},"num_stars":7,"is_starred":true}}';
          mod.methods.find(method => method.name === "files.revokePublicURL").response.sample 
            = '{"ok":true,"file":{"id":"F2147483862","timestamp":1356032811,"name":"file.htm","title":"My HTML file","mimetype":"text/plain","filetype":"text","pretty_type":"Text","user":"U2147483697","mode":"hosted","editable":true,"is_external":false,"external_type":"","size":12345,"url":"https://slack-files.com/files-pub/T024BE7LD-F024BERPE-09acb6/1.png","url_download":"https://slack-files.com/files-pub/T024BE7LD-F024BERPE-09acb6/download/1.png","url_private":"https://slack.com/files-pri/T024BE7LD-F024BERPE/1.png","url_private_download":"https://slack.com/files-pri/T024BE7LD-F024BERPE/download/1.png","thumb_64":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_64.png","thumb_80":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_80.png","thumb_360":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_360.png","thumb_360_gif":"https://slack-files.com/files-tmb/T024BE7LD-F024BERPE-c66246/1_360.gif","thumb_360_w":100,"thumb_360_h":100,"permalink":"https://tinyspeck.slack.com/files/cal/F024BERPE/1.png","permalink_public":"https://slack-files.com/T024BE7LD-F024BERPE-8004f909b1","edit_link":"https://tinyspeck.slack.com/files/cal/F024BERPE/1.png/edit","preview":"&lt;!DOCTYPE html&gt;\\n&lt;html&gt;\\n&lt;meta charset=\'utf-8\'&gt;","preview_highlight":"&lt;div class=\\"sssh-code\\"&gt;&lt;div class=\\"sssh-line\\"&gt;&lt;pre&gt;&lt;!DOCTYPE html","lines":123,"lines_more":118,"is_public":false,"public_url_shared":false,"channels":["C024BE7LT"],"groups":["G12345"],"initial_comment":{},"num_stars":7,"is_starred":true}}';
        }
        mod.methods.forEach(method => {
          method.response.sample = sanitizeResponse(method.name, method.response.sample);
          method.response.schema = parseResponseToSchema(method.name, method.response.sample);
        });
        const filepath = `${schema_dir}/web/${mod.name}.json`;
        fs.writeFileSync(filepath, JSON.stringify(mod, null, 2));
      });
      cb(null, true);
    });
  },
  (cb) => {
    parseMessages((err, messageTypes) => {
      const schema = {
        "$schema": "http://json-schema.org/draft-04/schema#",
        "title": "message",
        "oneOf": []
      };
      messageTypes.unshift({
        "name": "standard",
        "sample": JSON.stringify({
            "type": "message",
            "channel": "C2147483705",
            "user": "U2147483697",
            "text": "Hello world",
            "ts": "1355517523.000005",
            "edited": {
              "user": "U2147483697",
              "ts": "1355517536.000001"
            },
            "attachments": [
              {
                "fallback": "Required plain-text summary of the attachment.",
                "color": "#36a64f",
                "pretext": "Optional text that appears above the attachment block",
                "author_name": "Bobby Tables",
                "author_link": "http://flickr.com/bobby/",
                "author_icon": "http://flickr.com/icons/bobby.jpg",
                "title": "Slack API Documentation",
                "title_link": "https://api.slack.com/",
                "text": "Optional text that appears within the attachment",
                "fields": [
                  {
                    "title": "Priority",
                    "value": "High",
                    "short": false
                  }
                ],
                "image_url": "http://my-website.com/path/to/image.jpg",
                "thumb_url": "http://example.com/path/to/thumb.png",
                "footer": "Slack API",
                "footer_icon": "https://platform.slack-edge.com/img/default_application_icon.png",
                "ts": 123456789
              }
            ]
        })
      });
      messageTypes.filter((messageType) => messageType.sample !== "").forEach((messageType) => {
        const messageSchema = GenerateSchema.json(JSON.parse(sanitizeResponse(messageType.name, messageType.sample)));
        messageSchema.title = messageType.name;
        messageSchema["$schema"] = undefined;
        if (messageType.name === "bot_message") {
          messageSchema.properties.icons = {
            "type": "object",
            "properties": {
              "image_36": {
                "type": "string"
              },
              "image_48": {
                "type": "string"
              },
              "image_72": {
                "type": "string"
              }
            }
          };
        }
        if (messageType.name === "file_comment") {
          messageSchema.properties.file = { "$ref": "file.json" };
          messageSchema.properties.comment = { "$ref": "file_comment.json" };
        }
        if (messageType.name === "file_mention") {
          messageSchema.properties.file = { "$ref": "file.json" };
        }
        if (messageType.name === "file_share") {
          messageSchema.properties.file = { "$ref": "file.json" };
        }
        if (messageType.name === "message_replied") {
          messageSchema.properties.message.properties.reply_count = {"type": "integer"};
        }
        // if (messageType.name === "pinned_item") {
        //   messageSchema.properties.item = {
        //     "oneOf": [
        //       {
        //         "type": "object",
        //         "properties": {
        //           "type": { "type": "string" },
        //           "subtype": { "type": "string" },
        //           "user": { "type": "string" },
        //           "item_type": { "type": "string" },
        //           "text": { "type": "string" },
        //           "item": { "$ref": "objects/file.json" },
        //           "channel": { "type": "string" },
        //           "ts": { "type": "string" }
        //         },
        //         "title": "file"
        //       },
        //       {
                
        //       },
        //       {

        //       }
        //     ]
        //   };
        // }
        // if (messageType.name === "unpinned_item") {
        //   messageSchema.properties.item = { "$ref": "objects/pinned_item.json" };
        // }
        if (messageType.name === "reply_broadcast") {
          messageSchema.properties.attachments.items.required = undefined;
          messageSchema.properties.attachments.items.properties.id = {"type": "integer"};
        }
        schema.oneOf.push(messageSchema);
      });
      fs.writeFileSync(`${schema_dir}/objects/message.json`, JSON.stringify(schema, null, 2));
      cb(null, true);
    })
  }
], (err, results) => {
  console.log("Parsing complete!");
});
