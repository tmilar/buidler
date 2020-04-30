#!/usr/bin/env node
import Bugsnag from "@bugsnag/js";
import chalk from "chalk";
import debug from "debug";
import semver from "semver";
import "source-map-support/register";

import { TASK_HELP } from "../../builtin-tasks/task-names";
import { TaskArguments } from "../../types";
import { BUIDLER_NAME } from "../constants";
import { BuidlerContext } from "../context";
import { loadConfigAndTasks } from "../core/config/config-loading";
import { BuidlerError, BuidlerPluginError } from "../core/errors";
import { ERRORS, getErrorCode } from "../core/errors-list";
import { BUIDLER_PARAM_DEFINITIONS } from "../core/params/buidler-params";
import { getEnvBuidlerArguments } from "../core/params/env-variables";
import { isCwdInsideProject } from "../core/project-structure";
import { Environment } from "../core/runtime-environment";
import { loadTsNodeIfPresent } from "../core/typescript-support";
import { getPackageJson, PackageJson } from "../util/packageInfo";

import { Analytics } from "./analytics";
import { ArgumentsParser } from "./ArgumentsParser";
import { enableEmoji } from "./emoji";
import { createProject } from "./project-creation";

const log = debug("buidler:core:cli");

const ANALYTICS_SLOW_TASK_THRESHOLD = 300;

const BUGSNAG_API_KEY = "0d1affee077c44232592a0b985b2dca5";

async function printVersionMessage(packageJson: PackageJson) {
  console.log(packageJson.version);
}

function ensureValidNodeVersion(packageJson: PackageJson) {
  const requirement = packageJson.engines.node;
  if (!semver.satisfies(process.version, requirement)) {
    throw new BuidlerError(ERRORS.GENERAL.INVALID_NODE_VERSION, {
      requirement
    });
  }
}

async function main(): Promise<void> {
  // We first accept this argument anywhere, so we know if the user wants
  // stack traces before really parsing the arguments.
  let showStackTraces = process.argv.includes("--show-stack-traces");

  try {
    const packageJson = await getPackageJson();
    Bugsnag.start({
      apiKey: BUGSNAG_API_KEY,
      appVersion: packageJson.version
    });

    Bugsnag.addMetadata("company", {
      name: "Acme Co.",
      country: "uk"
    });

    ensureValidNodeVersion(packageJson);

    const envVariableArguments = getEnvBuidlerArguments(
      BUIDLER_PARAM_DEFINITIONS,
      process.env
    );

    const argumentsParser = new ArgumentsParser();

    const {
      buidlerArguments,
      taskName: parsedTaskName,
      unparsedCLAs
    } = argumentsParser.parseBuidlerArguments(
      BUIDLER_PARAM_DEFINITIONS,
      envVariableArguments,
      process.argv.slice(2)
    );

    if (buidlerArguments.verbose) {
      debug.enable("buidler*");
    }

    if (buidlerArguments.emoji) {
      enableEmoji();
    }

    showStackTraces = buidlerArguments.showStackTraces;

    if (
      buidlerArguments.config === undefined &&
      !isCwdInsideProject() &&
      process.stdout.isTTY === true
    ) {
      await createProject();
      return;
    }

    // --version is a special case
    if (buidlerArguments.version) {
      await printVersionMessage(packageJson);
      return;
    }

    loadTsNodeIfPresent();

    const ctx = BuidlerContext.createBuidlerContext();
    const config = loadConfigAndTasks(buidlerArguments);

    const analytics = await Analytics.getInstance(
      config.paths.root,
      config.analytics.enabled
    );

    const envExtenders = ctx.extendersManager.getExtenders();
    const taskDefinitions = ctx.tasksDSL.getTaskDefinitions();

    let taskName = parsedTaskName !== undefined ? parsedTaskName : "help";

    // tslint:disable-next-line: prefer-const
    let [abortAnalytics, hitPromise] = await analytics.sendTaskHit(taskName);

    let taskArguments: TaskArguments;

    // --help is a also special case
    if (buidlerArguments.help && taskName !== TASK_HELP) {
      taskArguments = { task: taskName };
      taskName = TASK_HELP;
    } else {
      const taskDefinition = taskDefinitions[taskName];

      if (taskDefinition === undefined) {
        throw new BuidlerError(ERRORS.ARGUMENTS.UNRECOGNIZED_TASK, {
          task: taskName
        });
      }

      taskArguments = argumentsParser.parseTaskArguments(
        taskDefinition,
        unparsedCLAs
      );
    }

    // TODO: This is here for backwards compatibility
    // There are very few projects using this.
    if (buidlerArguments.network === undefined) {
      buidlerArguments.network = config.defaultNetwork;
    }

    const env = new Environment(
      config,
      buidlerArguments,
      taskDefinitions,
      envExtenders
    );

    ctx.setBuidlerRuntimeEnvironment(env);

    const timestampBeforeRun = new Date().getTime();

    await env.run(taskName, taskArguments);

    const timestampAfterRun = new Date().getTime();
    if (
      timestampAfterRun - timestampBeforeRun >
      ANALYTICS_SLOW_TASK_THRESHOLD
    ) {
      await hitPromise;
    } else {
      abortAnalytics();
    }
    log(`Killing Buidler after successfully running task ${taskName}`);
  } catch (error) {
    // TODO here we catch lib run errors.
    Bugsnag.notify(error);

    let isBuidlerError = false;

    if (BuidlerError.isBuidlerError(error)) {
      isBuidlerError = true;
      console.error(chalk.red(`Error ${error.message}`));
    } else if (BuidlerPluginError.isBuidlerPluginError(error)) {
      isBuidlerError = true;
      console.error(
        chalk.red(`Error in plugin ${error.pluginName}: ${error.message}`)
      );
    } else if (error instanceof Error) {
      console.error(chalk.red("An unexpected error occurred:"));
      showStackTraces = true;
    } else {
      console.error(chalk.red("An unexpected error occurred."));
      showStackTraces = true;
    }

    console.log("");

    if (showStackTraces) {
      console.error(error.stack);
    } else {
      if (!isBuidlerError) {
        console.error(
          `If you think this is a bug in Buidler, please report it here: https://buidler.dev/reportbug`
        );
      }

      if (BuidlerError.isBuidlerError(error)) {
        const link = `https://buidler.dev/${getErrorCode(
          error.errorDescriptor
        )}`;

        console.error(
          `For more info go to ${link} or run ${BUIDLER_NAME} with --show-stack-traces`
        );
      } else {
        console.error(
          `For more info run ${BUIDLER_NAME} with --show-stack-traces`
        );
      }
    }

    if (isBuidlerError) {
      const {
        errorDescriptor: { title }
      } = error as BuidlerError;
      console.log("Buidler error title: ", title);
      if (title === ERRORS.GENERAL.UNSUPPORTED_OPERATION.title) {
        console.log("Restarting the app...");
        return main();
      }
    }

    process.exitCode = 1;
  }
}

main()
  .then(() => {
    console.log(`Process completed with exitCode ${process.exitCode}`);
    process.exit(process.exitCode);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
