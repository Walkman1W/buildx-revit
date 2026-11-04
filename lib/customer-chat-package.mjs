import {createCustomerComponentBuilder} from './customer-component-builder.mjs';
import {CUSTOMER_CHAT_COMPONENT_DEFINITION} from './customer-component-definitions.mjs';
import {KNOWN_CUSTOMER_CHAT_RELEASES} from '../release/customer-chat-known-releases.mjs';

const builder=createCustomerComponentBuilder(CUSTOMER_CHAT_COMPONENT_DEFINITION,Object.freeze({knownReleases:KNOWN_CUSTOMER_CHAT_RELEASES}));
export const planCustomerChatPackage=builder.plan;
export const buildCustomerChatPackage=builder.build;
export const verifyCustomerChatPackage=builder.verify;
export const verifyKnownCustomerChatRelease=builder.verifyKnownRelease;
export const cleanupCustomerChatPackageReads=builder.cleanup;
