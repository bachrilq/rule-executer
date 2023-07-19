import { getReadableDescription } from '@frmscoe/frms-coe-lib/lib/helpers/RuleConfig';
import { unwrap } from '@frmscoe/frms-coe-lib/lib/helpers/unwrap';
import {
  RuleConfig,
  RuleRequest,
  RuleResult,
} from '@frmscoe/frms-coe-lib/lib/interfaces';
import apm from 'elastic-apm-node';
import { handleTransaction } from 'rule/lib';
import { databaseManager, loggerService, server } from '..';
import { config } from '../config';
import determineOutcome from '../helpers/determineOutcome';

const calculateDuration = (startTime: bigint, endTime: bigint): number => {
  return Number(Number(startTime - endTime).toFixed(3));
};

export const execute = async (reqObj: unknown): Promise<void> => {
  let request!: RuleRequest;
  loggerService.log('Start - Handle execute request');
  const startTime = process.hrtime.bigint();

  // Get required information from the incoming request
  try {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const message = reqObj as any;
    request = {
      transaction: message.transaction,
      networkMap: message.networkMap,
      DataCache: message.DataCache,
      metaData: message?.metaData,
    };
  } catch (err) {
    const failMessage = 'Failed to parse execution request.';
    loggerService.error(failMessage, err, 'executeController');
    loggerService.log('End - Handle execute request');
    return;
  }

  let ruleRes: RuleResult = {
    id: `${config.ruleName}@${config.ruleVersion}`,
    cfg: '',
    result: false,
    subRuleRef: '.err',
    reason: 'Unhandled rule result outcome',
    desc: '',
    prcgTm: -1,
  };

  ruleRes.cfg = (() => {
    for (const messages of request.networkMap.messages) {
      for (const channels of messages.channels) {
        for (const typologies of channels.typologies) {
          for (const rule of typologies.rules) {
            if (rule.id === ruleRes.id) {
              return rule.cfg;
            }
          }
        }
      }
    }
    return '';
  })();

  let ruleConfig: RuleConfig | undefined;
  try {
    if (!ruleRes.cfg) throw new Error('Rule not found in network map');
    const sRuleConfig = await databaseManager.getRuleConfig(
      ruleRes.id,
      ruleRes.cfg,
    );
    ruleConfig = unwrap<RuleConfig>(sRuleConfig);
    if (!ruleConfig)
      throw new Error('Rule processor configuration not retrievable');
    ruleRes.desc = getReadableDescription(ruleConfig);
  } catch (error) {
    ruleRes.prcgTm = calculateDuration(startTime, process.hrtime.bigint());
    ruleRes = {
      ...ruleRes,
      subRuleRef: '.err',
      reason: (error as Error).message,
    };
    await server.handleResponse(
      JSON.stringify({
        transaction: request.transaction,
        ruleResult: ruleRes,
        networkMap: request.networkMap,
      }),
    );
    return;
  }
  const span = apm.startSpan('handleTransaction');
  try {
    ruleRes = await handleTransaction(
      request,
      determineOutcome,
      ruleRes,
      loggerService,
      ruleConfig,
      databaseManager,
    );

    span?.end();
  } catch (error) {
    span?.end();
    const failMessage = 'Failed to process execution request.';
    loggerService.error(failMessage, error, 'executeController');
    ruleRes = {
      ...ruleRes,
      subRuleRef: '.err',
      reason: (error as Error).message,
    };
  } finally {
    ruleRes.prcgTm = calculateDuration(startTime, process.hrtime.bigint());
    loggerService.log('End - Handle execute request');
  }

  try {
    await server.handleResponse({
      ...request,
      ruleResult: ruleRes,
    });
  } catch (error) {
    const failMessage = 'Failed to send to Typology Processor.';
    loggerService.error(failMessage, error, 'executeController');
    ruleRes = {
      ...ruleRes,
      subRuleRef: '.err',
      reason: (error as Error).message,
      result: false,
    };
  }
};
