export const REVERSELAB_ID='org.cetamesh.reverselab';
export const REVERSELAB_TOOL='analyze_javascript_application';
export const ANALYSIS_INPUT={type:'object',properties:{path:{type:'string',minLength:1,maxLength:500},
  outputPath:{type:'string',minLength:1,maxLength:500}},required:['path','outputPath'],additionalProperties:false};
export const HEALTH_INPUT={type:'object',properties:{},required:[],additionalProperties:false};
