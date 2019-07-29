import bcrypt from 'bcrypt'
import connection from './connection'
import setup from './setup'
import statusCodes from './statusCodes'
import memcache from './memcache'
import crypto from './crypto'
import userController from './user'

const SALT_ROUNDS = 10

// source: https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md#session-id-length
const ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID = 16
const SESSION_COOKIE_NAME = 'sessionId'

const VALIDATION_MESSAGE_LENGTH = 16

const oneDayMs = 1000 * 60 * 60 * 24
const SESSION_LENGTH = oneDayMs

const createSession = async function (userId, res) {
  const sessionId = crypto
    .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
    .toString('hex')

  const session = {
    'session-id': sessionId,
    'user-id': userId,
    'creation-date': new Date().toISOString()
  }

  const params = {
    TableName: setup.sessionsTableName,
    Item: session
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.put(params).promise()

  const cookieResponseHeaders = {
    maxAge: SESSION_LENGTH,
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production'
  }

  res.cookie(SESSION_COOKIE_NAME, sessionId, cookieResponseHeaders)
}

exports.signUp = async function (req, res) {
  const username = req.body.username
  const password = req.body.password
  const userId = req.body.userId
  const publicKey = req.body.publicKey

  if (!username || !password || !userId || !publicKey) return res
    .status(statusCodes['Bad Request'])
    .send({ readableMessage: 'Missing required items' })

  const publicKeyArrayBuffer = new Uint8Array(publicKey.data)

  try {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

    const validationMessage = crypto.randomBytes(VALIDATION_MESSAGE_LENGTH)

    const user = {
      username: username.toLowerCase(),
      'password-hash': passwordHash,
      'user-id': userId,
      'public-key': publicKeyArrayBuffer,
      'validation-message': validationMessage
    }

    const params = {
      TableName: setup.usersTableName,
      Item: user,
      // if username does not exist, insert
      // if it already exists and has a validation message, overwrite (bc key hasn't been validated yet)
      // if it already exists and does not have a validation message, fail with ConditionalCheckFailedException (bc already validated)
      ConditionExpression: 'attribute_not_exists(username) or attribute_exists(#validationMsg)',
      ExpressionAttributeNames: {
        '#validationMsg': 'validation-message'
      },
    }

    try {
      const ddbClient = connection.ddbClient()
      await ddbClient.put(params).promise()
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res
          .status(statusCodes['Conflict'])
          .send({
            err: `Failed to sign up with error ${e}`,
            readableMessage: 'Username already exists'
          })
      }
      throw e
    }

    const sharedSecret = crypto.diffieHellman.computeSecret(publicKeyArrayBuffer)
    const sharedKey = crypto.sha256.hash(sharedSecret)
    const encryptedValidationMessage = crypto.aesGcm.encrypt(sharedKey, validationMessage)

    await createSession(userId, res)

    return res.send(encryptedValidationMessage)
  } catch (e) {
    return res
      .status(statusCodes['Internal Server Error'])
      .send({ err: `Failed to sign up with ${e}` })
  }
}

exports.validateKey = async function (req, res) {
  const user = res.locals.user

  if (req.readableLength !== VALIDATION_MESSAGE_LENGTH) return res
    .status(statusCodes['Bad Request'])
    .send({ readableMessage: 'Validation message is incorect length' })

  try {
    const username = user['username']

    const validationMessage = req.read()

    const updateUserParams = {
      TableName: setup.usersTableName,
      Key: {
        'username': username
      },
      UpdateExpression: 'remove #validationMsg',
      ConditionExpression: '#validationMsg = :validationMsg',
      ExpressionAttributeNames: {
        '#validationMsg': 'validation-message'
      },
      ExpressionAttributeValues: {
        ':validationMsg': validationMessage,
      },
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()

    memcache.initUser(user['user-id'])

    return res.end()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res
        .status(statusCodes['Unauthorized'])
        .send({
          err: `Failed to validate key with error ${e}`,
          readableMessage: 'Invalid key.'
        })
    }
    return res
      .status(statusCodes['Internal Server Error'])
      .send({ err: `Failed to validate key with ${e}` })
  }
}

exports.signIn = async function (req, res) {
  const username = req.body.username
  const password = req.body.password

  const params = {
    TableName: setup.usersTableName,
    Key: {
      username: username.toLowerCase()
    },
  }

  try {
    const ddbClient = connection.ddbClient()
    const userResponse = await ddbClient.get(params).promise()

    const user = userResponse.Item
    if (!user) return res
      .status(statusCodes['Not Found'])
      .send({ readableMessage: 'Username not found' })

    const passwordMatch = await bcrypt.compare(password, user['password-hash'])
    if (!passwordMatch) return res
      .status(statusCodes['Unauthorized'])
      .send({ readableMessage: 'Incorrect password' })

    await createSession(user['user-id'], res)
    return res.end()
  } catch (e) {
    return res
      .status(statusCodes['Internal Server Error'])
      .send({ err: `Failed to sign up with ${e}` })
  }
}

exports.signOut = async function (req, res) {
  const sessionId = req.cookies.sessionId

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    },
    UpdateExpression: 'set invalidated = :invalidated',
    ExpressionAttributeValues: {
      ':invalidated': true,
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    res.clearCookie(SESSION_COOKIE_NAME)
    return res.send({ success: true })
  } catch (e) {
    return res
      .status(statusCodes['Internal Server Error'])
      .send({ err: `Failed to sign out with ${e}` })
  }
}

exports.authenticateUser = async function (req, res, next) {
  const sessionId = req.cookies.sessionId

  if (!sessionId) return res
    .status(statusCodes['Unauthorized'])
    .send({ readableMessage: 'Missing session token' })

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    const sessionResponse = await ddbClient.get(params).promise()

    // validate session
    const session = sessionResponse.Item
    if (!session) return res
      .status(statusCodes['Unauthorized'])
      .send({ readableMessage: 'Session does not exist' })

    if (session.invalidated) return res
      .status(statusCodes['Unauthorized'])
      .send({ readableMessage: 'Invalid session' })

    const sessionExpired = new Date() - new Date(session['creation-date']) > SESSION_LENGTH
    if (sessionExpired) return res
      .status(statusCodes['Unauthorized'])
      .send({ readableMessage: 'Session expired' })

    const userId = session['user-id']
    const user = await userController.findUserByUserId(userId)
    if (!user) return res
      .status(statusCodes['Not Found'])
      .send({ readableMessage: 'User no longer exists' })

    // ensure user has already validated key, unless user is trying to validate key
    if (req.path !== '/api/auth/validate-key') {
      if (user['validation-message']) return res
        .status(statusCodes['Unauthorized'])
        .send({ readableMessage: 'User has not validated key yet' })
    }

    res.locals.user = user // makes user object available in next route
    next()
  } catch (e) {
    return res
      .status(statusCodes['Internal Server Error'])
      .send({ err: `Failed to authenticate user with ${e}` })
  }
}
