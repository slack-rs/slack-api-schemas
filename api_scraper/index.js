const request = require('request');
const cheerio = require('cheerio');
const async = require('async');
const fs = require('fs');
const GenerateSchema = require('generate-schema');
const minimist = require('minimist');
const { start } = require('repl');

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

function sanitizeResponseSample(methodName, response) {
  try {
    // console.log("sanitizing [", methodName, "], [", response, "]");
    // remove anything before the first { and after the last }
    response = response.replace(/^[^{]*{/, "{");
    response = response.replace(/}[^}]*$/, "}");
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
    if (response[response.length - 1] === ',') {
      response = response.substring(0, response.length - 1);
    }

    response = response.trim();
    let responses = [];
    var braces = 0;
    var start = 0;
    for (let i = 0; i < response.length; i++) {
      if (response[i] == "{") {
        if (braces == 0) {
          start = i;
        }
        braces++;
      } else if (response[i] == "}" || response[i] == "}") {
        braces--;
        if (braces < 0) {
          throw ("incomplete object");
        } else if (braces == 0) {
          // console.log(`found ${start}, ${i}, ++>${response.slice(start, i + 1)}<++`);
          // append the object to responses
          responses.push(response.slice(start, i + 1));
        }
      }
    }

    // console.log("fred");
    // console.log(responses);
    if (responses.length == 0) {
      return [""];
    }
    for (let i = responses.length - 1; i >= 0; i--) {
      var new_string = null;
      try {
        new_string = JSON.parse(responses[i]);
        responses[i] = JSON.stringify(new_string);
      } catch (err) {
        if (response[1] == "'") {
          // https://api.slack.com/methods/admin.conversations.setConversationPrefs and others perhaps
          console.log(`${methodName} has a "stringified" JSON. Vomit.`);
          responses.splice(i, 1);
        } else if (methodName == "admin.inviteRequests.approved.list") {
          console.log(`${methodName} example has a [] delimited hash.`);
          responses.splice(i, 1);
        } else {
          console.log(`failed to parse / stringify "${methodName}" ==> ${responses[i]}<==`);
          throw (err);
        }
      }

    }
    return responses;
  } catch (err) {
    console.log(`failed to sanitize "${methodName}", -->`, response, `< --, ${err}`)
    throw (err);

  }
}

function schema(path, injectedSchema) {
  return (schema) => {
    const newSchema = schema;
    const parts = path.split('.');
    let section = newSchema;
    for (let i = 0; i < parts.length - 1; i++) {
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
    for (let i = 0; i < parts.length - 1; i++) {
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
    for (let i = 0; i < parts.length - 1; i++) {
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
    for (let i = 0; i < parts.length - 1; i++) {
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
    for (let i = 0; i < parts.length - 1; i++) {
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
  try {
    return (schema) => {
      const newSchema = schema;
      const parts = path.split('.');
      let section = newSchema;
      for (let i = 0; i < parts.length - 1; i++) {
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
  } catch (err) {
    console.error(`treat as map "${path}", "${props}"`);
    throw (err);
  }
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
    schema("files.total", { "type": "integer" })
  ]],
  ["search.messages", [
    schemaListRef("messages.matches", MESSAGE_SCHEMA),
    schemaRef("messages.paging", PAGING_SCHEMA),
    schema("messages.total", { "type": "integer" })
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
    schema("logins[].count", { "type": "integer" }),
    setRequired("logins[]", undefined)
  ]],
  ["team.billableInfo", [treatAsMap("billable_info")]],
  ["team.integrationLogs", [
    schemaRef("paging", PAGING_SCHEMA),
    setRequired("logs[]", undefined),
  ]],
  ["team.info", [schemaRef("team", TEAM_SCHEMA)]],
  ["team.profile.get", [
    treatAsMap("profile.fields[].options", { "type": "string" }),
    schemaList("profile.fields[].possible_values", { "type": "string" }),
    schema("profile.fields[].is_hidden", { "type": "boolean" }),
    schema("profile.fields[].ordering", { "type": "integer" }),
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

function JSONSampleToSchema(methodName, sample) {
  // console.log(methodName, sample);
  let schema = GenerateSchema.json(sample);
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

}

function parseResponseSampleToSchema(methodName, response) {
  if (response.trim().length === 0) {
    console.log(`Empty response sample for ${methodName}`);
    return {};
  }

  try {
    let json = JSON.parse(response);
    return JSONSampleToSchema(json);
  } catch (e) {
    console.log(`Failed to parse response object for ${methodName}.${e}`);
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

function getParamTypeFromExample(method, name, documentedType, example) {
  if (documentedType.length > 0) {
    return documentedType;
  } else if (example === "xxxx-xxxxxxxxx-xxxx") {
    return "auth_token";
  } else if (example === "true" || example === "false") {
    return "boolean";
  } else if (example === "0" || example === "1") {
    console.log(`Marking ${method} param ${name} as boolean because it was ${example} `)
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

/**
 * Remove response shapes we cannot yet handle
 * 
 * @param {Object} responses 
 */
function filter_unsupported(responses) {
  let result = [];
  for (response of responses) {
    if (response.headers["Content-type"] == "application/gzip") {
      continue;
    }
    result.push(response);
  }
  return result;
}

simple_words = /(\w+[_.]*)+/
function parseSlackMethod(methodName, description, cb) {
  const url = `https://api.slack.com/methods/${methodName}`;
  cacheGetOrAdd(url, (err, res, html) => {
    try {
      // console.log("processing", methodName);
      let skipStrings = [
        "already_closed",
        "foo=bar",
        "no_op",
        "not_in_channel",
        "num_members",
        "im",
        "mpim",
        "text/plain",
        "paid_only",
        "is_member",
        "num_members",
        "conversations",
        "active",
        "away",
        "identity.email",
        "identity.avatar",
        "identity.team",
      ];
      const $$ = cheerio.load(html);

      const params = $$('table.apiDocsTable').first().find('tr').slice(1).map((i, arg) => {
        const paramName = $$(arg).children().eq(0).children().find('a').text();
        const required = $$(arg).children().eq(0).text().includes("Required");
        const documentedType = $$(arg).children().eq(1).text();
        const example = $$(arg).children().eq(2).children().find(".apiReference__methodExample").find("code").text();
        // console.log(documentedType, example);
        skipStrings.push(paramName);
        return {
          name: paramName,
          type: getParamTypeFromExample(methodName, paramName, documentedType, example),
          optional: !required,
          description: $$(arg).children().eq(2).find("p").text().trim()
        };
      }).get();

      if ($$('div.apiReference__response').find(".apiReference__example").children().length == 0) {
        console.log("No examples found for ", methodName);
      }
      let responses = $$('div.apiReference__response').find(".apiReference__example").slice(0).map((i, example) => {
        // console.log(`Example ${i}, has ${$$(example).children().find("code").length} code children`);
        var type = null;
        let [content_type, ...content] = $$(example).children().find("code").slice(0).map((i, arg) => {
          const text = $$(arg).text();
          // console.log(text);
          if (type !== null) {
            if (type == "application/gzip") {
              return {
                "headers": { "Content-Disposition": `attachment;filename=${text}` }
              };
            } else if (type == "application/json") {
              return {
                "headers": {},
                body: JSON.parse(text)
              };
            } else {
              console.error("unimplemented type", type);
              throw ("unimplemented type")
            }
          }

          if (text == 'Content-type: application/gzip') {
            type = "application/gzip";
          } else if (text == 'Content-type: application/json') {
            type = "application/json";
          } else {
            // If it parses as JSON, its probably a single example
            try {
              return {
                "headers": { 'Content-type': 'application/json' },
                body: JSON.parse(text)
              };
            } catch (err) {
              for (skipString of skipStrings) {
                if (skipString == text)
                  return "invalid";
              }
              // single simple strings are also never examples
              if (simple_words.exec(text) != null) {
                console.log(`skipping ${text}`);
                return "invalid";
              }
              console.log("Failed to process", methodName, err.message, `[${text}]`, `[${$$(example).text()}]`);
              throw (err);
            }
          }
          return type;
        }).get();
        // Patterns seen:
        // code(Content-Type: xxx) + filename
        // code(Content-Type: xxx) + code(JSON)?
        // code(URL params) + code(JSON response)
        // code(param name) + code(JSON response)
        // code(JSON)

        for (i = content.length - 1; i >= 0; i--) {
          if (content[i] == "invalid") {
            content.splice(i, 1);
          }
        }
        // console.log("example", i, content_type, content);
        if (content.length == 0) {
          return content_type;
        } else if (content.length == 1) {
          content[0]['headers']['Content-type'] = content_type;
          return content[0];
        } else {
          throw ("unexpected example length");
        }
      }).get();
      // Docs pages have good responses and error responses. Parse them all and merge and hope.
      // Then serialise back to a string. Then sanitise again.

      if ($$('div.apiDocsPage__markdownOutput').find("code").text().length != 0) {
        let markdown_text = $$('div.apiDocsPage__markdownOutput').find("code").text();
        // console.log(`markdown -->${markdown_text}<<-`);

        let markdowns = sanitizeResponseSample(methodName, markdown_text);
        if (markdowns.length != 1 || markdowns[0] != "") {
          // console.log(`sanitized: [${markdowns}]`);
          responses.splice(responses.length, 0, ...(markdowns.map(JSON.parse).map((response) => {
            return {
              "headers": { 'Content-type': 'application/json' },
              body: response,
            };
          }
          )));
        }

      }


      // Future: expand the code generator to understand the admin.getFile contract etc. For now, filter it out.
      let filtered_responses = filter_unsupported(responses);
      if (filtered_responses.length == 0) {
        console.log("only unsupported responses present", methodName);
      }
      // thank you https://gist.github.com/ahtcx/0cd94e62691f539160b32ecda18af3d6#gistcomment-3585151
      function deepMerge(target, source) {
        if (source === null) {
          return target;
        }
        const result = { ...target, ...source };
        const keys = Object.keys(result);
        // console.log("merging [", source, "] into [", target, "] merged [", result, "]");

        for (const key of keys) {
          // console.log("merge:", source, target);
          const tprop = target[key];
          const sprop = source[key];
          //if two objects are in conflict
          if (typeof (tprop) == 'object' && typeof (sprop) == 'object') {
            result[key] = deepMerge(tprop, sprop);
          }
        }
        return result;
      }
      let response = JSONSampleToSchema(methodName, filtered_responses.reduce(deepMerge, {})["body"]);


      // console.log("yy", filtered_responses, response, "yy");
      const errors = $$('h2#errors').nextAll('table.apiDocsTable').first().find('tr').slice(1).map((i, arg) => {
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
          sample: undefined,
          schema: response,
          errors: errors
        }
      });
    } catch (err) {
      console.log("failed to process", methodName);
      throw (err);
    }
  });
}

function parseSlackApi(cb) {
  cacheGetOrAdd("https://api.slack.com/methods", (err, response, html) => {
    if (err) {
      throw "Could not load main Slack API documentation.";
    }

    const $ = cheerio.load(html);

    var modules = {};

    const sections = $('.apiReferenceFilterableList__list').children();

    async.mapLimit(sections, 3, (elem, done) => {
      const className = elem.attribs["class"];
      const methodName = className.split('--')[1].split(' ')[0];
      const moduleName = methodName.split(".")[0]
      if (!modules[moduleName]) {
        modules[moduleName] = {
          name: moduleName.trim(),
          description: '',
          methods: [],
        };
      }
      const description = $(elem).find('.apiReferenceFilterableList__listItemDescription').text();

      parseSlackMethod(methodName, description, done);
    }, (err, results) => {
      for (let result of results) {
        modules[result["name"].split(".")[0]].methods.push(result);
      }
      // console.log(modules);
      cb(modules);
    });
  });
}

function parseMessages(done) {
  cacheGetOrAdd("https://api.slack.com/events/message", (err, response, html) => {
    if (err) {
      return done("Could not load message documentation. " + err);
    }

    const $ = cheerio.load(html);

    const raw_data = $('.apiReferenceFilterableList__preload').first().parent().attr('data-automount-props');
    async.mapLimit(JSON.parse(raw_data).items, 3, (message_type, map_done) => {
      // console.log("message type [", message_type, "]");
      const name = message_type.name;
      const description = message_type.description;

      cacheGetOrAdd("https://api.slack.com" + message_type.link /*"https://api.slack.com/events/message/" + name*/, (err, response, html) => {
        if (err) {
          return map_done(`Could not load message:${name} documentation. ` + err);
        }
        // console.log("processing message type [", name, "]");

        const $$ = cheerio.load(html);

        const sample = $$('pre');
        if (sample.length > 1) {
          console.log(`Saw more than one sample for message:${name}`)
        }

        if (!message_type.isDeprecated || sample.length > 0) {
          // console.log("message", message_type.name, message_type.isDeprecated, "[", sample.first().text(), "]");
          map_done(null, {
            name: name,
            description: description,
            sample: sample.first().text(),
            is_deprecated: message_type.isDeprecated,
            is_public: message_type.isPublic,
            groups: message_type.groups,
          });
        } else {
          map_done(null, null);
        }
      });
    }, done);
  });
}

async.parallel([
  (cb) => {
    parseSlackApi((modules) => {
      for (let modName of Object.keys(modules)) {
        let mod = modules[modName];
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
          if (method.response.sample !== undefined) {
            console.log("overriding sample for", method.name);
            method.response.sample = sanitizeResponseSample(method.name, method.response.sample)[0];
            method.response.schema = parseResponseSampleToSchema(method.name, method.response.sample);
          }
        });
        const filepath = `${schema_dir}/web/${mod.name}.json`;
        fs.writeFileSync(filepath, JSON.stringify(mod, null, 2));
      };
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
      for (let i = messageTypes.length - 1; i >= 0; i--) {
        if (messageTypes[i] == null) {
          messageTypes.splice(i, 1);
        }
      }
      messageTypes.forEach((messageType) => {
        const messageSchema = GenerateSchema.json(JSON.parse(sanitizeResponseSample(messageType.name, messageType.sample)[0]));
        // console.log(messageType.name, "[", messageType.sample, "]");
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
          messageSchema.properties.message.properties.reply_count = { "type": "integer" };
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
          messageSchema.properties.attachments.items.properties.id = { "type": "integer" };
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
