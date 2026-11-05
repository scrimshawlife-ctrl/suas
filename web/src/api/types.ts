import type { components } from './schema';

/** Short names for the generated schemas screens use most. */
export type Schemas = components['schemas'];
export type Me = Schemas['VeteranMe'];
export type County = Schemas['ServiceCounty'];
export type ServiceCategory = Schemas['ServiceCategory'];
export type ServiceRequestStatus = Schemas['ServiceRequestStatus'];
export type ServiceRequestListItem = Schemas['ServiceRequestListItem'];
export type ServiceRequestDetail = Schemas['ServiceRequestDetail'];
export type ChatThread = Schemas['ChatThread'];
