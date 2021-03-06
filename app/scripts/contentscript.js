const fs = require('fs')
const path = require('path')
const pump = require('pump')
const log = require('loglevel')
const querystring = require('querystring')
const { Writable } = require('readable-stream')
const LocalMessageDuplexStream = require('post-message-stream')
const ObjectMultiplex = require('obj-multiplex')
const extension = require('extensionizer')
const PortStream = require('extension-port-stream')

const inpageContent = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'chrome', 'inpage.js')).toString()
const inpageSuffix = '//# sourceURL=' + extension.runtime.getURL('inpage.js') + '\n'
const inpageBundle = inpageContent + inpageSuffix

// Eventually this streaming injection could be replaced with:
// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Language_Bindings/Components.utils.exportFunction
//
// But for now that is only Firefox
// If we create a FireFox-only code path using that API,
// MetaMask will be much faster loading and performant on Firefox.

if (shouldInjectProvider()) {
  injectScript(inpageBundle)
  start()
}

/**
 * Injects a script tag into the current document
 *
 * @param {string} content - Code to be executed in the current document
 */
function injectScript (content) {
  try {
    const container = document.head || document.documentElement
    const scriptTag = document.createElement('script')
    scriptTag.setAttribute('async', false)
    scriptTag.textContent = content
    container.insertBefore(scriptTag, container.children[0])
    container.removeChild(scriptTag)
  } catch (e) {
    console.error('MetaMask provider injection failed.', e)
  }
}

/**
 * Sets up the stream communication and submits site metadata
 *
 */
async function start () {
  await setupStreams()
  await domIsReady()
}

/**
 * Sets up two-way communication streams between the
 * browser extension and local per-page browser context.
 *
 */
async function setupStreams () {
  // the transport-specific streams for communication between inpage and background
  const pageStream = new LocalMessageDuplexStream({
    name: 'contentscript',
    target: 'inpage',
  })

  const extensionPort = extension.runtime.connect({ name: 'contentscript' })
  const extensionStream = new PortStream(extensionPort)

  // create and connect channel muxers
  // so we can handle the channels individually
  const pageMux = new ObjectMultiplex()
  pageMux.setMaxListeners(25)
  const extensionMux = new ObjectMultiplex()
  extensionMux.setMaxListeners(25)

  pump(
    pageMux,
    pageStream,
    pageMux,
    (err) => logStreamDisconnectWarning('MetaMask Inpage Multiplex', err)
  )
  pump(
    extensionMux,
    extensionStream,
    extensionMux,
    (err) => logStreamDisconnectWarning('MetaMask Background Multiplex', err)
  )

  const onboardingStream = pageMux.createStream('onboarding')
  const addCurrentTab = new Writable({
    objectMode: true,
    write: (chunk, _, callback) => {
      if (!chunk) {
        return callback(new Error('Malformed onboarding message'))
      }

      const handleSendMessageResponse = (error, success) => {
        if (!error && !success) {
          error = extension.runtime.lastError
        }
        if (error) {
          log.error(`Failed to send ${chunk.type} message`, error)
          return callback(error)
        }
        callback(null)
      }

      try {
        if (chunk.type === 'registerOnboarding') {
          extension.runtime.sendMessage({ type: 'metamask:registerOnboarding', location: window.location.href }, handleSendMessageResponse)
        } else {
          throw new Error(`Unrecognized onboarding message type: '${chunk.type}'`)
        }
      } catch (error) {
        log.error(error)
        return callback(error)
      }
    },
  })

  pump(
    onboardingStream,
    addCurrentTab,
    error => console.error('MetaMask onboarding channel traffic failed', error),
  )

  // forward communication across inpage-background for these channels only
  forwardTrafficBetweenMuxers('provider', pageMux, extensionMux)
  forwardTrafficBetweenMuxers('publicConfig', pageMux, extensionMux)
  forwardTrafficBetweenMuxers('cap', pageMux, extensionMux)

  // connect "phishing" channel to warning system
  const phishingStream = extensionMux.createStream('phishing')
  phishingStream.once('data', redirectToPhishingWarning)
}

function forwardTrafficBetweenMuxers (channelName, muxA, muxB) {
  const channelA = muxA.createStream(channelName)
  const channelB = muxB.createStream(channelName)
  pump(
    channelA,
    channelB,
    channelA,
    (err) => logStreamDisconnectWarning(`MetaMask muxed traffic for channel "${channelName}" failed.`, err)
  )
}

/**
 * Error handler for page to extension stream disconnections
 *
 * @param {string} remoteLabel Remote stream name
 * @param {Error} err Stream connection error
 */
function logStreamDisconnectWarning (remoteLabel, err) {
  let warningMsg = `MetamaskContentscript - lost connection to ${remoteLabel}`
  if (err) {
    warningMsg += '\n' + err.stack
  }
  console.warn(warningMsg)
}

/**
 * Determines if the provider should be injected
 *
 * @returns {boolean} {@code true} if the provider should be injected
 */
function shouldInjectProvider () {
  return doctypeCheck() && suffixCheck() &&
    documentElementCheck() && !blacklistedDomainCheck()
}

/**
 * Checks the doctype of the current document if it exists
 *
 * @returns {boolean} {@code true} if the doctype is html or if none exists
 */
function doctypeCheck () {
  const doctype = window.document.doctype
  if (doctype) {
    return doctype.name === 'html'
  } else {
    return true
  }
}

/**
 * Returns whether or not the extension (suffix) of the current document is prohibited
 *
 * This checks {@code window.location.pathname} against a set of file extensions
 * that we should not inject the provider into. This check is indifferent of
 * query parameters in the location.
 *
 * @returns {boolean} whether or not the extension of the current document is prohibited
 */
function suffixCheck () {
  const prohibitedTypes = [
    /\.xml$/,
    /\.pdf$/,
  ]
  const currentUrl = window.location.pathname
  for (let i = 0; i < prohibitedTypes.length; i++) {
    if (prohibitedTypes[i].test(currentUrl)) {
      return false
    }
  }
  return true
}

/**
 * Checks the documentElement of the current document
 *
 * @returns {boolean} {@code true} if the documentElement is an html node or if none exists
 */
function documentElementCheck () {
  const documentElement = document.documentElement.nodeName
  if (documentElement) {
    return documentElement.toLowerCase() === 'html'
  }
  return true
}

/**
 * Checks if the current domain is blacklisted
 *
 * @returns {boolean} {@code true} if the current domain is blacklisted
 */
function blacklistedDomainCheck () {
  const blacklistedDomains = [
    'uscourts.gov',
    'dropbox.com',
    'webbyawards.com',
    'cdn.shopify.com/s/javascripts/tricorder/xtld-read-only-frame.html',
    'adyen.com',
    'gravityforms.com',
    'harbourair.com',
    'ani.gamer.com.tw',
    'blueskybooking.com',
    'sharefile.com',
  ]
  const currentUrl = window.location.href
  let currentRegex
  for (let i = 0; i < blacklistedDomains.length; i++) {
    const blacklistedDomain = blacklistedDomains[i].replace('.', '\\.')
    currentRegex = new RegExp(`(?:https?:\\/\\/)(?:(?!${blacklistedDomain}).)*$`)
    if (!currentRegex.test(currentUrl)) {
      return true
    }
  }
  return false
}

/**
 * Redirects the current page to a phishing information page
 */
function redirectToPhishingWarning () {
  console.log('MetaMask - routing to Phishing Warning component')
  const extensionURL = extension.runtime.getURL('phishing.html')
  window.location.href = `${extensionURL}#${querystring.stringify({
    hostname: window.location.hostname,
    href: window.location.href,
  })}`
}

/**
 * Returns a promise that resolves when the DOM is loaded (does not wait for images to load)
 */
async function domIsReady () {
  // already loaded
  if (['interactive', 'complete'].includes(document.readyState)) {
    return
  }
  // wait for load
  await new Promise(resolve => window.addEventListener('DOMContentLoaded', resolve, { once: true }))
}

// /**
//  * Reloads the site
//  */
// function forceReloadSite () {
//   window.location.reload()
// }
