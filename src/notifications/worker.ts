import { config } from "../config.js";
import { checkPendingPushReceipts, sendUnpushedNotifications } from "./push.js";
import { generateNotificationsForAllVehicles } from "./service.js";

type WorkerLogger = {
  info: (value: object, message: string) => void;
  warn: (value: object, message: string) => void;
};

let isRunning = false;

export const runNotificationWorkerOnce = async () => {
  if (isRunning) {
    return {
      checkedReceipts: 0,
      createdNotifications: 0,
      sentPendingNotifications: 0,
      skipped: true,
    };
  }

  isRunning = true;

  try {
    const createdNotifications = await generateNotificationsForAllVehicles();
    const sentPendingNotifications = await sendUnpushedNotifications();
    const checkedReceipts = await checkPendingPushReceipts();

    return {
      checkedReceipts,
      createdNotifications: createdNotifications.length,
      sentPendingNotifications,
      skipped: false,
    };
  } finally {
    isRunning = false;
  }
};

export const startNotificationWorker = (logger: WorkerLogger) => {
  if (!config.notificationWorkerEnabled) {
    return () => undefined;
  }

  const run = async () => {
    try {
      const result = await runNotificationWorkerOnce();

      if (!result.skipped) {
        logger.info(result, "Notification worker completed.");
      }
    } catch (error) {
      logger.warn({ error }, "Notification worker failed.");
    }
  };

  void run();
  const intervalId = setInterval(run, config.notificationWorkerIntervalMs);

  return () => {
    clearInterval(intervalId);
  };
};
