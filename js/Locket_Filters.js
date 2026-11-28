// ============================================================
// Locket Filters & PhotoBooth Bridge
// Endpoints: generateFilteredImage and generateCaption
// Dùng cho: Loon / Quantumult X / Surge / Shadowrocket
// ============================================================
var WORKER = "";
var NATIVE_API = /^https:\/\/(?:api\.locketcamera\.com|us-central1-locket-4252a\.cloudfunctions\.net)\/(?:[^?#]*\/)?generateFilteredImage(?:\?|$)/i;
var CAPTION_WORKER = "";
var NATIVE_CAPTION_API = /^https:\/\/(?:api\.locketcamera\.com|us-central1-locket-4252a\.cloudfunctions\.net)\/(?:[^?#]*\/)?generateCaption(?:\?|$)/i;
var isCaptionRequest = false;
var finished = false;

function done(value) {
  if (finished) return;
  finished = true;
  $done(value);
}

function respondError(code, message) {
  done({
    response: {
      status: code,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        error: {
          status: isCaptionRequest ? "CAPTION_BACKEND_ERROR" : "FILTER_BACKEND_ERROR",
          message: message
        }
      })
    }
  });
}

function getHeader(source, name) {
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key) && key.toLowerCase() === name.toLowerCase()) {
      return source[key];
    }
  }
  return "";
}

function parseUrlSafe(rawUrl) {
  if (typeof URL === "function") {
    var u = new URL(rawUrl);
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      pathname: u.pathname
    };
  }
  var m = String(rawUrl).match(/^(https?:)\/\/([^\/?#]+)([^?#]*)/i);
  if (!m) throw new Error("URL_PARSE_FAILED");
  return {
    protocol: m[1].toLowerCase(),
    hostname: m[2].toLowerCase(),
    pathname: m[3] || "/"
  };
}

(function run() {
  var reqUrl = (typeof $request !== "undefined" && $request && $request.url) ? String($request.url) : "";
  var reqMethod = (typeof $request !== "undefined" && $request && $request.method) ? String($request.method).toUpperCase() : "POST";

  isCaptionRequest = NATIVE_CAPTION_API.test(reqUrl);
  if (!isCaptionRequest && !NATIVE_API.test(reqUrl)) return done({});
  if (reqMethod !== "POST") return done({});

  var targetWorker = isCaptionRequest ? CAPTION_WORKER : WORKER;
  if (!targetWorker || !/^https:\/\//i.test(targetWorker)) {
    return respondError(503, "BACKEND_OFFLINE_USE_WEB_PHOTOBOOTH");
  }

  var original;
  try {
    original = JSON.parse(($request && $request.body) || "{}");
    if (!original || !original.data || typeof original.data !== "object") {
      throw new Error("INVALID_DATA");
    }
    if (!isCaptionRequest && (typeof original.data.image_url !== "string" || !original.data.image_url.trim())) {
      throw new Error("IMAGE_URL_MISSING");
    }
    if (isCaptionRequest) {
      var capImg = original.data.image_base64 || original.data.imageBase64;
      if (typeof capImg !== "string" || !capImg.trim()) {
        throw new Error("CAPTION_IMAGE_MISSING");
      }
    }
  } catch (e) {
    return respondError(400, "INVALID_NATIVE_REQUEST");
  }

  if (!isCaptionRequest && !original.data.captured_at) {
    original.data.captured_at = new Date().toISOString();
  }

  var forwardedBody = JSON.stringify(original);
  var nativeHeaders = ($request && $request.headers) || {};
  var workerHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  var FORWARD_FIREBASE_AUTH = false;
  if (FORWARD_FIREBASE_AUTH) {
    var auth = getHeader(nativeHeaders, "authorization");
    var appCheck = getHeader(nativeHeaders, "x-firebase-appcheck");
    if (auth) workerHeaders.Authorization = auth;
    if (appCheck) workerHeaders["X-Firebase-AppCheck"] = appCheck;
  }

  if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function") {
    return respondError(503, "HTTPCLIENT_UNAVAILABLE");
  }

  $httpClient.post({
    url: targetWorker,
    headers: workerHeaders,
    body: forwardedBody,
    timeout: isCaptionRequest ? 25 : 95
  }, function (error, response, responseBody) {
    if (error || !response) return respondError(502, "WORKER_CONNECTION_FAILED");

    var status = Number(response.status || response.statusCode || 0);
    var rawBody = String(responseBody || "");
    var result = null;
    var jsonValid = false;

    if (rawBody.trim()) {
      try {
        result = JSON.parse(rawBody);
        jsonValid = true;
      } catch (e) {
        jsonValid = false;
      }
    }

    if (
      status === 202 ||
      (result && result.status === "waiting") ||
      (result && result.result && result.result.data && result.result.data.phase === "pending")
    ) {
      return respondError(409, "PHOTOBOOTH_WAITING_FOR_SHOTS");
    }

    if (status !== 200) {
      var errMsg = (result && result.error && result.error.message)
        ? String(result.error.message)
        : (!jsonValid && rawBody.trim() ? "WORKER_NON_JSON_HTTP_" + status : "WORKER_HTTP_" + status);
      return respondError(status >= 400 && status < 600 ? status : 502, errMsg);
    }

    if (!jsonValid || !result || typeof result !== "object") {
      return respondError(502, "WORKER_INVALID_JSON");
    }

    if (isCaptionRequest) {
      if (!result.result || typeof result.result.caption !== "string") {
        return respondError(502, "WORKER_CAPTION_MISSING");
      }
      return done({
        response: {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
          },
          body: JSON.stringify(result)
        }
      });
    }

    var imageUrl = result.result && result.result.data && result.result.data.output_url;
    if (typeof imageUrl !== "string" || !imageUrl.trim()) {
      return respondError(502, "WORKER_OUTPUT_URL_MISSING");
    }

    try {
      var parsed = parseUrlSafe(imageUrl);
      if (parsed.protocol !== "https:") throw new Error("NOT_HTTPS");
      var allowedHost =
        parsed.hostname === "teongweii.github.io" ||
        parsed.hostname === "i.ibb.co" ||
        (parsed.hostname === "firebasestorage.googleapis.com" && parsed.pathname.indexOf("/v0/b/locket-filters/o/") === 0);
      if (!allowedHost) throw new Error("OUTPUT_HOST_DENIED");
    } catch (e) {
      return respondError(502, "WORKER_OUTPUT_URL_INVALID");
    }

    done({
      response: {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        },
        body: JSON.stringify({
          result: {
            data: {
              output_url: imageUrl
            }
          }
        })
      }
    });
  });
})();
