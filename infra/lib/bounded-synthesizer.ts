import { CfnResource, DefaultStackSynthesizer, type ISynthesisSession } from 'aws-cdk-lib';

/** Cross-region helper roles are created after CDK's boundary aspect has run. */
export class BoundedSynthesizer extends DefaultStackSynthesizer {
  override synthesize(session: ISynthesisSession): void {
    const stack = this.boundStack;
    for (const child of stack.node.findAll()) {
      if (CfnResource.isCfnResource(child) && child.cfnResourceType === 'AWS::IAM::Role') {
        child.addPropertyOverride(
          'PermissionsBoundary',
          stack.formatArn({
            service: 'iam',
            region: '',
            resource: 'policy',
            resourceName: 'SuasStagingRuntimeBoundary',
          }),
        );
      }
    }
    super.synthesize(session);
  }
}
