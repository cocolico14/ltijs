// Dependencies
const crypto = require('crypto')
const Jwk = require('rasha')
const got = require('got')
const jwt = require('jsonwebtoken')
const url = require('fast-url-parser')
const consAuthDebug = require('debug')('consumer:auth')

// Classes
const Tool = require('./Tool')
const ToolLink = require('./ToolLink')
const Database = require('../../../GlobalUtils/Database')

// Helpers
const messageTypes = require('../../../GlobalUtils/Helpers/messageTypes')
const privacyLevels = require('../../../GlobalUtils/Helpers/privacy')
const validScopes = require('../../../GlobalUtils/Helpers/scopes')

/**
 * Verifies JWTs sent by a Tool
 * @param {String} token
 * @param {Tool} tool
 * @param {String} alg
 * @param {String} kid
 * @returns Verified payload
 */
const verifyToken = async (token, tool, alg, kid) => {
  consAuthDebug('Validating JWT')
  const authConfig = await tool.authConfig()
  let verified
  switch (authConfig.method) {
    case 'JWK_SET': {
      consAuthDebug('Retrieving key from jwk_set')
      if (!kid) throw new Error('MISSING_KID_PARAMETER')
      const keysEndpoint = authConfig.key
      const res = await got.get(keysEndpoint).json()
      const keyset = res.keys
      if (!keyset) throw new Error('KEYSET_NOT_FOUND')
      const jwk = keyset.find(key => {
        return key.kid === kid
      })
      if (!jwk) throw new Error('KEY_NOT_FOUND')
      consAuthDebug('Converting JWK key to PEM key')
      const key = await Jwk.export({ jwk: jwk })
      verified = jwt.verify(token, key, { algorithms: [alg] })
      break
    }
    case 'JWK_KEY': {
      consAuthDebug('Retrieving key from jwk_key')
      if (!authConfig.key) throw new Error('KEY_NOT_FOUND')
      const key = Jwk.jwk2pem(authConfig.key)
      verified = jwt.verify(token, key, { algorithms: [alg] })
      break
    }
    case 'RSA_KEY': {
      consAuthDebug('Retrieving key from rsa_key')
      const key = authConfig.key
      if (!key) throw new Error('KEY_NOT_FOUND')
      verified = jwt.verify(token, key, { algorithms: [alg] })
      break
    }
    default: {
      consAuthDebug('No auth configuration found for tool')
      throw new Error('AUTHCONFIG_NOT_FOUND')
    }
  }
  return verified
}

/**
 * Find scope code based on value
 * @param {String} value
 * @returns
 */
const getScopeCode = (value) => {
  return Object.keys(validScopes).find(key => validScopes[key] === value)
}

/**
 * @description Authentication class manages RSA keys and validation and creation of tokens.
 */
class Auth {
  /**
   * @description Validates LTI 1.3 Login request
   * @param {Object} obj - Login request object.
   * @param {String} encryptionkey - Consumer encryption key.
   */
  static async validateLoginRequest (obj, encryptionkey) {
    consAuthDebug('Validating login request')
    consAuthDebug('Validating lti_message_hint claim')
    if (!obj.lti_message_hint) throw new Error('MISSING_LTI_MESSAGE_HINT_CLAIM')
    let messageHint
    try {
      messageHint = jwt.verify(obj.lti_message_hint, encryptionkey)
    } catch {
      throw new Error('INVALID_MESSAGE_HINT_CLAIM')
    }
    const loginRequest = {
      toolLink: messageHint.toolLink,
      resource: messageHint.resource,
      type: messageHint.type
    }
    if (loginRequest.type === messageTypes.DEEPLINKING_LAUNCH) loginRequest.dlState = crypto.randomBytes(16).toString('hex')

    consAuthDebug('Validating nonce claim')
    if (!obj.nonce) throw new Error('MISSING_NONCE_CLAIM')
    if (await Database.get('nonce', { nonce: obj.nonce })) throw new Error('NONCE_ALREADY_RECEIVED')
    consAuthDebug('Storing nonce')
    await Database.insert('nonce', { nonce: obj.nonce })

    consAuthDebug('Validating scope claim')
    if (obj.scope !== 'openid') throw new Error('INVALID_SCOPE_CLAIM')
    consAuthDebug('Validating response_type claim')
    if (obj.response_type !== 'id_token') throw new Error('INVALID_RESPONSE_TYPE_CLAIM')
    consAuthDebug('Validating response_mode claim')
    if (obj.response_mode !== 'form_post') throw new Error('INVALID_RESPONSE_MODE_CLAIM')
    consAuthDebug('Validating prompt claim')
    if (obj.prompt !== 'none') throw new Error('INVALID_PROMPT_CLAIM')

    consAuthDebug('Validating client ID claim')
    if (!obj.client_id) throw new Error('MISSING_CLIENT_ID_CLAIM')
    const tool = await Tool.getTool(obj.client_id)
    if (!tool) throw new Error('INVALID_CLIENT_ID_CLAIM')
    loginRequest.clientId = obj.client_id

    consAuthDebug('Validating lti_deployment_id claim')
    if (!obj.lti_deployment_id) throw new Error('MISSING_LTI_DEPLOYMENT_ID_CLAIM')
    if ((await tool.deploymentId()) !== obj.lti_deployment_id) throw new Error('INVALID_LTI_DEPLOYMENT_ID_CLAIM')
    loginRequest.deploymentId = obj.lti_deployment_id

    consAuthDebug('Validating redirect_uri claim')
    if (!obj.redirect_uri) throw new Error('MISSING_REDIRECT_URI_CLAIM')
    if (!((await tool.redirectURIs()).includes(obj.redirect_uri))) throw new Error('INVALID_REDIRECT_URI_CLAIM')
    loginRequest.redirectUri = obj.redirect_uri

    consAuthDebug('Validating login_hint claim')
    if (!obj.login_hint) throw new Error('MISSING_LOGIN_HINT_CLAIM')
    loginRequest.user = obj.login_hint

    consAuthDebug('Retrieving state claim')
    if (obj.state) loginRequest.state = obj.state

    return loginRequest
  }

  /**
   * @description Validates LTI 1.3 Deep Linking Response
   * @param {Object} obj - Deep Linking response object.
   * @param {Object} query - Deep Linking query object.
   * @param {Object} consumer - Consumer configurations.
   */
  static async validateDeepLinkingResponse (obj, query, consumer) {
    consAuthDebug('Validating deep linking response')
    if (!obj.JWT) throw new Error('MISSING_JWT_PARAMETER')
    const decoded = jwt.decode(obj.JWT, { complete: true })
    const tool = await Tool.getTool(decoded.payload.iss)
    if (!tool) throw new Error('TOOL_NOT_FOUND')
    consAuthDebug('Validating JWT')
    const verified = await verifyToken(obj.JWT, tool, decoded.header.alg, decoded.header.kid)

    consAuthDebug('Validating nonce claim')
    if (verified.nonce) {
      if (await Database.get('nonce', { nonce: verified.nonce })) throw new Error('NONCE_ALREADY_RECEIVED')
      consAuthDebug('Storing nonce')
      await Database.insert('nonce', { nonce: verified.nonce })
    }

    consAuthDebug('Validating aud claim')
    if (verified.aud !== consumer.url) throw new Error('INVALID_AUD_CLAIM')
    consAuthDebug('Validating deployment ID claim')
    if (verified['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] !== (await tool.deploymentId())) throw new Error('INVALID_DEPLOYMENT_ID_CLAIM')
    consAuthDebug('Validating message type claim')
    if (verified['https://purl.imsglobal.org/spec/lti/claim/message_type'] !== messageTypes.DEEPLINKING_RESPONSE) throw new Error('INVALID_MESSAGE_TYPE_CLAIM')
    consAuthDebug('Validating version claim')
    if (verified['https://purl.imsglobal.org/spec/lti/claim/version'] !== '1.3.0') throw new Error('INVALID_VERSION_CLAIM')

    const deepLinkingResponse = {
      clientId: verified.iss,
      deploymentId: verified.deploymentId,
      contentItems: verified['https://purl.imsglobal.org/spec/lti-dl/claim/content_items'],
      message: verified['https://purl.imsglobal.org/spec/lti-dl/claim/msg'],
      log: verified['https://purl.imsglobal.org/spec/lti-dl/claim/log'],
      error: verified['https://purl.imsglobal.org/spec/lti-dl/claim/errormsg'],
      errorLog: verified['https://purl.imsglobal.org/spec/lti-dl/claim/errorlog'],
      contextId: query.contextId,
      state: query.dlState
    }

    return deepLinkingResponse
  }

  /**
   * @description Creates a signed ID Token JWT.
   * @param {Object} loginRequest - Valid login request object.
   * @param {Object} _idtoken - Information used to build the ID Token.
   * @param {Object} consumer - Consumer configurations.
   */
  static async buildIdToken (loginRequest, _idtoken, consumer) {
    if (!loginRequest) throw new Error('MISSING_LOGIN_REQUEST_PARAMETER')
    if (!_idtoken) throw new Error('MISSING_IDTOKEN_PARAMETER')

    consAuthDebug('Building ID Token')
    const toolObject = await Tool.getTool(loginRequest.clientId)
    if (!toolObject) throw new Error('INVALID_CLIENT_ID_CLAIM')
    const tool = await toolObject.toJSON()
    const idtoken = {
      iss: consumer.url,
      aud: loginRequest.clientId,
      'https://purl.imsglobal.org/spec/lti/claim/deployment_id': loginRequest.deploymentId,
      sub: loginRequest.user,
      'https://purl.imsglobal.org/spec/lti/claim/roles': _idtoken.user.roles,
      'https://purl.imsglobal.org/spec/lti/claim/context': {
        id: _idtoken.launch.context.id,
        label: _idtoken.launch.context.label,
        title: _idtoken.launch.context.title,
        type: _idtoken.launch.context.type
      },
      'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
      nonce: encodeURIComponent([...Array(25)].map(_ => (Math.random() * 36 | 0).toString(36)).join``)
    }

    idtoken['https://purl.imsglobal.org/spec/lti/claim/message_type'] = loginRequest.type
    if (loginRequest.type === messageTypes.DEEPLINKING_LAUNCH) {
      const deepLinkingReturnUrl = url.format({
        protocol: consumer.protocol,
        hostname: consumer.hostname,
        port: consumer.port,
        auth: consumer.auth,
        hash: consumer.hash,
        pathname: consumer.deepLinkingResponseRoute,
        query: {
          contextId: _idtoken.launch.context.id,
          dlState: loginRequest.dlState
        }
      })
      idtoken['https://purl.imsglobal.org/spec/lti/claim/custom'] = tool.customParameters
      idtoken['https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings'] = {
        deep_link_return_url: deepLinkingReturnUrl,
        accept_types: ['ltiResourceLink'],
        accept_presentation_document_targets: ['iframe', 'window'],
        accept_multiple: false,
        auto_create: false,
        title: tool.name
      }
      if (tool.privacy === privacyLevels.COMPLETE || tool.privacy === privacyLevels.EMAIL) idtoken.email = _idtoken.user.email
      if (tool.privacy === privacyLevels.COMPLETE || tool.privacy === privacyLevels.NAME) {
        idtoken.given_name = _idtoken.user.givenName
        idtoken.family_name = _idtoken.user.familyName
        idtoken.name = _idtoken.user.name
      }
    } else {
      const toolLinkObject = await ToolLink.getToolLink(loginRequest.toolLink)
      if (!toolLinkObject) throw new Error('INVALID_TOOL_LINK_ID')
      const toolLink = await toolLinkObject.toJSON()
      idtoken['https://purl.imsglobal.org/spec/lti/claim/custom'] = { ...tool.customParameters, ...toolLink.customParameters }
      idtoken['https://purl.imsglobal.org/spec/lti/claim/target_link_uri'] = toolLink.url
      idtoken['https://purl.imsglobal.org/spec/lti/claim/resource_link'] = _idtoken.launch.resource
      const privacy = toolLink.privacy === privacyLevels.INHERIT ? tool.privacy : toolLink.privacy
      if (privacy === privacyLevels.COMPLETE || privacy === privacyLevels.EMAIL) idtoken.email = _idtoken.user.email
      if (privacy === privacyLevels.COMPLETE || privacy === privacyLevels.NAME) {
        idtoken.given_name = _idtoken.user.givenName
        idtoken.family_name = _idtoken.user.familyName
        idtoken.name = _idtoken.user.name
      }
    }
    // Signing ID Token
    consAuthDebug('Signing ID Token')
    const token = jwt.sign(idtoken, await toolObject.privateKey(), { algorithm: 'RS256', expiresIn: '1h', keyid: tool.kid })
    return token
  }

  /**
   * @description Creates self-submitting form containing signed ID Token.
   * @param {Object} loginRequest - Valid login request object.
   * @param {Object} _idtoken - Information used to build the ID Token.
   * @param {Object} consumer - Consumer configurations.
   */
  static async buildIdTokenForm (loginRequest, _idtoken, consumer) {
    const idtoken = await Auth.buildIdToken(loginRequest, _idtoken, consumer)
    let form = `<form id="ltiadv_authenticate" style="display: none;" action="${loginRequest.redirectUri}" method="POST">`
    if (loginRequest.state) form += `<input type="hidden" name="state" value="${loginRequest.state}"/>`
    form += `<input type="hidden" name="id_token" value="${idtoken}"/></form><script>document.getElementById("ltiadv_authenticate").submit()</script>`
    return form
  }

  /**
   * @description Creates self-submitting form containing signed ID Token.
   * @param {Object} res - Express response object.
   * @param {Object} loginRequest - Valid login request object.
   * @param {Object} _idtoken - Information used to build the ID Token.
   * @param {Object} consumer - Consumer configurations.
   */
  static async buildIdTokenResponse (res, loginRequest, _idtoken, consumer) {
    const idtokenForm = await Auth.buildIdTokenForm(loginRequest, _idtoken, consumer)
    res.setHeader('Content-type', 'text/html')
    return res.send(idtokenForm)
  }

  /**
   * @description Generates a new access token for a Tool.
   * @param {Object} body - Access token request body.
   * @param {Object} consumer - Consumer configurations.
   * @param {String} encryptionkey - Consumer encryption key.
   */
  static async generateAccessToken (body, consumer, encryptionkey) {
    consAuthDebug('Validating access token request')
    consAuthDebug('Validating grant type claim')
    if (body.grant_type !== 'client_credentials') throw new Error('INVALID_GRANT_TYPE_CLAIM')
    consAuthDebug('Validating client assertion type claim')
    if (body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') throw new Error('INVALID_CLIENT_ASSERTION_TYPE_CLAIM')

    consAuthDebug('Validating scope claim')
    const decoded = jwt.decode(body.client_assertion, { complete: true })
    const tool = await Tool.getTool(decoded.payload.sub)
    if (!tool) throw new Error('INVALID_CLIENT_ID')
    if (!body.scope) throw new Error('MISSING_SCOPE_CLAIM')
    const scopes = body.scope.split(' ')
    const toolScopes = await tool.scopes()
    for (const scope of scopes) {
      const code = getScopeCode(scope)
      if (!code || !toolScopes.includes(code)) throw new Error('INVALID_SCOPE_CLAIM. Details: Invalid or unauthorized scope: ' + scope)
    }

    consAuthDebug('Validating client assertion claim')
    if (!body.client_assertion) throw new Error('MISSING_CLIENT_ASSERTION_CLAIM')
    const accesstokenURL = url.format({
      protocol: consumer.protocol,
      hostname: consumer.hostname,
      port: consumer.port,
      auth: consumer.auth,
      hash: consumer.hash,
      pathname: consumer.accesstokenRoute
    })
    if (Array.isArray(decoded.payload.aud) && !decoded.payload.aud.includes(accesstokenURL)) throw new Error('INVALID_AUD_CLAIM')
    else if (decoded.payload.aud !== accesstokenURL) throw new Error('INVALID_AUD_CLAIM')
    await verifyToken(body.client_assertion, tool, decoded.header.alg, decoded.header.kid)

    // Building Access Token
    const accessTokenPayload = {
      clientId: decoded.payload.sub,
      scopes: body.scope
    }
    const accessToken = jwt.sign(accessTokenPayload, encryptionkey, { expiresIn: 3600 })
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      scope: body.scope
    }
  }

  /**
   * @description Validates access token.
   * @param {String} token - Access token.
   * @param {String} scope - Requested scope.
   * @param {String} encryptionkey - Consumer encryption key.
   */
  static async validateAccessToken (token, scope, encryptionkey) {
    const verified = jwt.verify(token, encryptionkey)
    const scopes = verified.scopes.split(' ')
    if (!scopes.includes(scope)) throw new Error('UNAUTHORIZED_SCOPE')

    const tool = await Tool.getTool(verified.clientId)
    if (!tool) throw new Error('TOOL_NOT_FOUND')
    const toolScopes = await tool.scopes()
    const code = getScopeCode(scope)
    if (!code || !toolScopes.includes(code)) throw new Error('INVALID_SCOPE_CLAIM. Details: Invalid or unauthorized scope: ' + scope)

    return true
  }
}

module.exports = Auth