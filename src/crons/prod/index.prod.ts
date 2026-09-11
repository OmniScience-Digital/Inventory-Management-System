import logger from '../../utils/logger';
import cron from 'node-cron';
import { getFleetvehicles } from '../../helper/fleet/fleet.helper';
import { getFleetTasks } from '../../helper/task/task.helper';
import { FleetController } from '../../controllers/cron.fleetController';
import { addQuoteJob } from '../../queues/quotes.queue';

logger.info('Prod Cron Loaded');

// Set the time zone to Johannesburg, South Africa (SAST)
const timeZone = 'Africa/Johannesburg';

(async () => {
  logger.info('🕒 Starting Prod Quote cron...');
  await addQuoteJob();
})();

//Task 1am cron

cron.schedule(
  '0 1 * * *',
  async () => {
    try {
      logger.info('[CRON] Triggered 01:00 (2AM) Task Check');

      const fleets = await getFleetvehicles();
      const tasks = await getFleetTasks();

      if (fleets && tasks) {
        //call fleet controller
        await FleetController(fleets, tasks);
      } else {
        logger.warn('No valid progressive sites to process');
      }
    } catch (error: any) {
      logger.error('Runtime error:', error);
    }
  },
  { timezone: timeZone }
);
