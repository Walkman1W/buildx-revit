// Contract projections captured from successful legacy host receipts on
// 2026-10-28. IDs and SHA-256 identify the original local evidence. User model
// paths, titles and business data are replaced; these are not raw user receipts.
const captures=[
  {id:'f9539d03-4b60-4dd0-af9b-e3148c0e7213',operation:'list_levels',sha256:'0ddfecd6dd5eb17b8aa2d6f8819feea9b9d7bcc45d7d4f0e8a27b278f16054ee',value:{items:[{element_id:1,name:'Level 1',elevation_mm:0,project_elevation_mm:0}]}},
  {id:'b6ad6411-8263-4781-837a-651697e07d0a',operation:'search_elements',sha256:'9e4761f366429d856bf08b801ccc23e37c32d2b84d61b99aa0bfd76c7a69aea7',value:{items:[],total:0,offset:0,limit:20,has_more:false}},
  {id:'20cad552-19ac-4042-8342-e8a3f5dd99c4',operation:'list_family_types',sha256:'b1acdc57c04e0ef790dae13dcf7c3a95fdbe9a59fbb929c80d941bdad8dd3344',value:{items:[],total:0,offset:0,limit:20,has_more:false}}
];
export const capturedAtomicReadFixtures=captures.map(capture=>{
  const session='d'.repeat(32),document={title:'Contract sample',path:'D:\\fixtures\\contract-sample.rvt'};
  return {
    sourceReceiptId:capture.id,receiptHash:capture.sha256,
    projection:'Captured legacy contract shape; private model fields and business values normalized',
    request:{operation:capture.operation,args:{expected_document:document.path,...capture.operation!=='list_levels'?{limit:20,offset:0}:{}}},
    receipt:{id:capture.id,ok:true,completedUtc:'2026-10-28T12:44:54.1082140Z',result:{
      operation:capture.operation,hostSession:session,atomicReadSnapshot:true,
      snapshot:{hostSession:session,hostVersion:'0.6.4',dispatcher:'ExternalEvent',revitPid:1234,document:{...document,activeViewId:12,activeViewType:'ThreeD',allowedSample:true,modified:true},capabilities:{atomicReadSnapshot:true}},
      value:{operation:capture.operation,hostSession:session,document:{...document},value:capture.value}
    }}
  };
});
