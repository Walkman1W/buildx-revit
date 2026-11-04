import {createCustomerComponentBuilder} from './customer-component-builder.mjs';
import {FRONTEND_COMPONENT_DEFINITION} from './customer-component-definitions.mjs';

const builder=createCustomerComponentBuilder(FRONTEND_COMPONENT_DEFINITION);
export const planCustomerAssets=builder.plan;
export const buildCustomerAssets=builder.build;
export const verifyCustomerAssets=builder.verify;
export const cleanupCustomerAssetReads=builder.cleanup;
