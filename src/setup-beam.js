const core = require('@actions/core')
const { exec } = require('@actions/exec')
const os = require('os')
const path = require('path')
const semver = require('semver')
const https = require('https')
const fs = require('fs')
const installer = require('./installer')

main().catch((err) => {
  core.setFailed(err.message)
})

async function main() {
  installer.checkPlatform()

  const versionFilePath = getInput('version-file', false)
  let versions
  if (versionFilePath) {
    if (!isStrictVersion()) {
      throw new Error(
        "you have to set version-type=strict if you're using version-file",
      )
    }
    versions = parseVersionFile(versionFilePath)
  }

  const osVersion = getRunnerOSVersion()
  const otpVersion = getInput('otp-version', true, 'erlang', versions)
  const elixirSpec = getInput('elixir-version', false, 'elixir', versions)
  const gleamSpec = getInput('gleam-version', false, 'gleam', versions)
  const rebar3Spec = getInput('rebar3-version', false, 'rebar', versions)

  if (otpVersion !== 'false') {
    await installOTP(otpVersion, osVersion)
    const elixirInstalled = await maybeInstallElixir(elixirSpec, otpVersion)

    if (elixirInstalled === true) {
      const shouldMixRebar = getInput('install-rebar', false)
      await mix(shouldMixRebar, 'rebar')
      const shouldMixHex = getInput('install-hex', false)
      await mix(shouldMixHex, 'hex')
    }
  } else if (!gleamSpec) {
    throw new Error('otp-version=false is only available when installing Gleam')
  }

  await maybeInstallGleam(gleamSpec)
  await maybeInstallRebar3(rebar3Spec)
}

async function installOTP(otpVersion, osVersion) {
  console.log(
    `##[group]Installing Erlang/OTP ${otpVersion} - built on ${osVersion}`,
  )
  await installer.installOTP(osVersion, otpVersion)
  core.setOutput('otp-version', otpVersion)
  core.addPath(`${process.env.RUNNER_TEMP}/.setup-beam/otp/bin`)
  console.log('##[endgroup]')

  return otpVersion
}

async function maybeInstallElixir(elixirSpec, otpVersion) {
  let installed = false

  if (elixirSpec) {
    const elixirVersion = await getElixirVersion(elixirSpec, otpVersion)
    console.log(`##[group]Installing Elixir ${elixirVersion}`)
    await installer.installElixir(elixirVersion)
    core.setOutput('elixir-version', elixirVersion)
    const disableProblemMatchers = getInput('disable_problem_matchers', false)
    if (disableProblemMatchers === 'false') {
      const matchersPath = path.join(__dirname, '..', '.github')
      console.log(
        `##[add-matcher]${path.join(matchersPath, 'elixir-matchers.json')}`,
      )
    }
    core.addPath(`${os.homedir()}/.mix/escripts`)
    core.addPath(`${process.env.RUNNER_TEMP}/.setup-beam/elixir/bin`)
    console.log('##[endgroup]')

    installed = true
  }

  return installed
}

async function mix(shouldMix, what) {
  if (shouldMix === 'true') {
    const cmd = 'mix'
    const args = [`local.${what}`, '--force']
    console.log(`##[group]Running ${cmd} ${args}`)
    await exec(cmd, args)
    console.log('##[endgroup]')
  }
}

async function maybeInstallGleam(gleamSpec) {
  let installed = false

  if (gleamSpec) {
    const gleamVersion = await getGleamVersion(gleamSpec)
    console.log(`##[group]Installing Gleam ${gleamVersion}`)
    await installer.installGleam(gleamVersion)
    core.setOutput('gleam-version', gleamVersion)
    core.addPath(`${process.env.RUNNER_TEMP}/.setup-beam/gleam/bin`)
    console.log('##[endgroup]')

    installed = true
  }

  return installed
}

async function maybeInstallRebar3(rebar3Spec) {
  let installed = false
  let rebar3Version

  if (rebar3Spec) {
    if (rebar3Spec === 'nightly') {
      rebar3Version = 'nightly'
    } else {
      rebar3Version = await getRebar3Version(rebar3Spec)
    }
    console.log(`##[group]Installing rebar3 ${rebar3Version}`)
    await installer.installRebar3(rebar3Version)
    core.setOutput('rebar3-version', rebar3Version)
    core.addPath(`${process.env.RUNNER_TEMP}/.setup-beam/rebar3/bin`)
    console.log('##[endgroup]')

    installed = true
  }

  return installed
}

async function getElixirVersion(exSpec0, otpVersion0) {
  const otpVersion = otpVersion0.match(/^([^-]+-)?(.+)$/)[2]
  const otpVersionMajor = otpVersion.match(/^([^.]+).*$/)[1]
  const elixirVersions = await getElixirVersions()
  const semverVersions = Array.from(elixirVersions.keys()).sort()
  const exSpec = exSpec0.replace(/-otp-.*$/, '')
  const elixirVersionFromSpec = getVersionFromSpec(exSpec, semverVersions, true)
  let elixirVersionForDownload = elixirVersionFromSpec
  if (isVersion(otpVersionMajor)) {
    elixirVersionForDownload = `${elixirVersionFromSpec}-otp-${otpVersionMajor}`
  }
  if (elixirVersionFromSpec === null) {
    throw new Error(
      `Requested Elixir version (${exSpec0}) not found in version list ` +
        "(should you be using option 'version-type': 'strict'?)",
    )
  }

  const elixirVersionComp = elixirVersions.get(elixirVersionFromSpec)
  if (
    (elixirVersionComp && elixirVersionComp.includes(otpVersionMajor)) ||
    !isVersion(otpVersionMajor)
  ) {
    core.info(
      `Using Elixir ${elixirVersionFromSpec} (built for Erlang/OTP ${otpVersionMajor})`,
    )
  } else {
    throw new Error(
      `Requested Elixir / Erlang/OTP version (${exSpec0} / ${otpVersion0}) not ` +
        'found in version list (did you check Compatibility between Elixir and Erlang/OTP?)',
    )
  }

  return maybePrependWithV(elixirVersionForDownload)
}

async function getGleamVersion(gleamSpec0) {
  const gleamSpec = gleamSpec0.match(/^v?(.+)$/)
  const gleamVersions = await getGleamVersions()
  const gleamVersion = getVersionFromSpec(gleamSpec[1], gleamVersions, true)
  if (gleamVersion === null) {
    throw new Error(
      `Requested Gleam version (${gleamSpec0}) not found in version list ` +
        "(should you be using option 'version-type': 'strict'?)",
    )
  }

  return maybePrependWithV(gleamVersion, gleamVersion)
}

async function getRebar3Version(r3Spec) {
  const rebar3Versions = await getRebar3Versions()
  const rebar3Version = getVersionFromSpec(r3Spec, rebar3Versions)
  if (rebar3Version === null) {
    throw new Error(
      `Requested rebar3 version (${r3Spec}) not found in version list ` +
        "(should you be using option 'version-type': 'strict'?)",
    )
  }

  return rebar3Version
}

async function getElixirVersions() {
  const elixirVersionsListings = await get(
    'https://repo.hex.pm/builds/elixir/builds.txt',
    [null],
  )
  const otpVersionsForElixirMap = new Map()

  elixirVersionsListings
    .trim()
    .split('\n')
    .forEach((line) => {
      const elixirMatch =
        line.match(/^v?(.+)-otp-([^ ]+)/) || line.match(/^v?([^ ]+)/)
      const elixirVersion = maybePrependWithV(elixirMatch[1])
      const otpVersion = elixirMatch[2]
      const otpVersions = otpVersionsForElixirMap.get(elixirVersion) || []
      if (otpVersion) {
        // -otp- present (special case)
        otpVersions.push(otpVersion)
      }
      otpVersionsForElixirMap.set(elixirVersion, otpVersions)
    })

  return otpVersionsForElixirMap
}

async function getGleamVersions() {
  const resultJSONs = await get(
    'https://api.github.com/repos/gleam-lang/gleam/releases?per_page=100',
    [1, 2, 3],
  )
  const gleamVersionsListing = []
  resultJSONs.forEach((resultJSON) => {
    JSON.parse(resultJSON)
      .map((x) => x.tag_name)
      .sort()
      .forEach((v) => gleamVersionsListing.push(v))
  })
  return gleamVersionsListing
}

async function getRebar3Versions() {
  const resultJSONs = await get(
    'https://api.github.com/repos/erlang/rebar3/releases?per_page=100',
    [1, 2, 3],
  )
  const rebar3VersionsListing = []
  resultJSONs.forEach((resultJSON) => {
    JSON.parse(resultJSON)
      .map((x) => x.tag_name)
      .sort()
      .forEach((v) => rebar3VersionsListing.push(v))
  })
  return rebar3VersionsListing
}

function isStrictVersion() {
  return getInput('version-type', false) === 'strict'
}

function getVersionFromSpec(spec, versions, maybePrependWithV0) {
  let version = null

  if (spec.match(/rc/) || isStrictVersion()) {
    version = spec
  }

  if (version === null) {
    // We keep a map of semver => "spec" in order to use semver ranges to find appropriate versions
    const versionsMap = versions.sort(sortVersions).reduce((acc, v) => {
      if (!v.match(/rc/)) {
        // release candidates are opt-in
        acc[maybeCoerced(v)] = v
      }
      return acc
    }, {})
    const rangeForMax = semver.validRange(spec)
    if (rangeForMax) {
      version =
        versionsMap[semver.maxSatisfying(Object.keys(versionsMap), rangeForMax)]
    } else {
      version = versionsMap[maybeCoerced(spec)]
    }
  }

  let v = version === null || version === undefined ? null : version
  if (maybePrependWithV0 && v != null) {
    v = maybePrependWithV(v)
  }
  return v
}

function maybeCoerced(v) {
  let ret

  try {
    ret = semver.coerce(v).version
  } catch {
    // some stuff can't be coerced, like 'master'
    ret = v
  }

  return ret
}

function sortVersions(left, right) {
  let ret = 0
  const newL = verAsComparableStr(left)
  const newR = verAsComparableStr(right)

  function verAsComparableStr(ver) {
    const matchGroups = 5
    const verSpec = /([^.]+)?\.?([^.]+)?\.?([^.]+)?\.?([^.]+)?\.?([^.]+)?/
    const matches = ver.match(verSpec).splice(1, matchGroups)
    return matches.reduce((acc, v) => acc + (v || '0').padStart(3, '0'), '')
  }

  if (newL < newR) {
    ret = -1
  } else if (newL > newR) {
    ret = 1
  }

  return ret
}

function getRunnerOSVersion() {
  const ImageOSToContainer = {
    ubuntu18: 'ubuntu-18.04',
    ubuntu20: 'ubuntu-20.04',
    ubuntu22: 'ubuntu-22.04',
    win19: 'windows-2019',
    win22: 'windows-2022',
  }
  const containerFromEnvImageOS = ImageOSToContainer[process.env.ImageOS]

  if (!containerFromEnvImageOS) {
    throw new Error(
      "Tried to map a target OS from env. variable 'ImageOS' (got " +
        `${process.env.ImageOS}` +
        "), but failed. If you're using a " +
        "self-hosted runner, you should set 'env': 'ImageOS': ... to one of the following: " +
        "['" +
        `${Object.keys(ImageOSToContainer).join("', '")}` +
        "']",
    )
  }

  return containerFromEnvImageOS
}

async function get(url0, pageIdxs) {
  function getPage(pageIdx) {
    return new Promise((resolve, reject) => {
      const url = new URL(url0)
      if (pageIdx !== null) {
        url.searchParams.append('page', pageIdx)
      }
      https
        .get(
          url,
          {
            headers: { 'user-agent': 'setup-beam' },
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => {
              if (res.statusCode >= 400 && res.statusCode <= 599) {
                reject(
                  new Error(
                    `Got ${res.statusCode} from ${url}. Exiting with error`,
                  ),
                )
              } else {
                resolve(data)
              }
            })
          },
        )
        .on('error', (err) => {
          reject(err)
        })
    })
  }
  let ret
  if (pageIdxs[0] === null) {
    ret = getPage(null)
  } else {
    ret = Promise.all(pageIdxs.map((pageIdx) => getPage(pageIdx)))
  }
  return ret
}

function maybePrependWithV(v) {
  if (isVersion(v)) {
    return `v${v.replace('v', '')}`
  }
  return v
}

function isVersion(v) {
  return /^v?\d+/.test(v)
}

function getInput(inputName, required, alternativeName, alternatives) {
  const alternativeValue = (alternatives || new Map()).get(alternativeName)
  let input = core.getInput(inputName, {
    required: alternativeValue ? false : required,
  })
  // We can't have both input and alternativeValue set
  if (input && alternativeValue) {
    throw new Error(
      `Found input ${inputName}=${input} (from the YML) \
alongside ${alternativeName}=${alternativeValue} \
(from the version file). You must choose one or the other.`,
    )
  } else if (!input) {
    input = alternativeValue
  }
  return input
}

function parseVersionFile(versionFilePath0) {
  const versionFilePath = path.join(
    process.env.GITHUB_WORKSPACE,
    versionFilePath0,
  )
  if (!fs.existsSync(versionFilePath)) {
    throw new Error(
      `The specified version file, ${versionFilePath0}, does not exist`,
    )
  }
  console.log(`##[group]Parsing version file at ${versionFilePath0}`)
  const appVersions = new Map()
  const versions = fs.readFileSync(versionFilePath, 'utf8')
  // For the time being we parse .tool-versions
  // If we ever start parsing something else, this should
  // become default in a new option named e.g. version-file-type
  versions.split('\n').forEach((line) => {
    const appVersion = line.match(/^([^ ]+)[ ]+([^ #]+)/)
    if (appVersion) {
      const app = appVersion[1]
      if (['erlang', 'elixir', 'gleam', 'rebar'].includes(app)) {
        const [, , version] = appVersion
        console.log(`Consuming ${app} at version ${version}`)
        appVersions.set(app, version)
      }
    }
  })
  if (!appVersions.size) {
    console.log('There was apparently nothing to consume')
  } else {
    console.log('... done!')
  }
  console.log('##[endgroup]')

  return appVersions
}

module.exports = {
  getElixirVersion,
  getGleamVersion,
  getRebar3Version,
  getVersionFromSpec,
  parseVersionFile,
}
