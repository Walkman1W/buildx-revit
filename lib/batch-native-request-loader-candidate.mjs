// Disabled until the application owns an atomic trusted native-image loader.
// A pre-load pathname hash alone does not prevent replacement during require().
export function loadBatchNativeRequestOwner(){
 throw Object.assign(new Error('Native batch request owner unavailable: trusted image binding is not established.'),{code:'BATCH_NATIVE_OWNER_UNAVAILABLE'});
}
