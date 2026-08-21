import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { ContractProps } from '../../domain/routing/contract';
import type { RoutingCompanyProps } from '../../domain/routing/routing-company';
import {
  RouteExportService,
  type RouteExportContext,
} from './route-export.service';

const address = {
  label: 'Garagem',
  street: 'Rua A',
  number: '10',
  complement: null,
  district: 'Centro',
  postalCode: '38400000',
  city: 'Uberlandia',
  state: 'MG',
  latitude: -18.91,
  longitude: -48.27,
};

const context: RouteExportContext = {
  routingCompany: {
    id: 'client-id',
    companyId: 'tenant-id',
    taxId: '12345678000195',
    legalName: 'Cliente Industrial SA',
    tradeName: 'Cliente Industrial',
    costCenter: 'LEGADO',
    status: 'active',
    avicExternalId: null,
    avicLastSyncedAt: null,
    version: 1,
    createdByUserId: 'actor-id',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  } satisfies RoutingCompanyProps,
  contract: {
    id: 'contract-id',
    companyId: 'tenant-id',
    routingCompanyId: 'client-id',
    code: 'CTR-01',
    name: 'Contrato Industrial',
    operationType: 'Fretamento',
    routeType: 'municipal',
    status: 'active',
    periodicity: 'monthly',
    contractedVehicleCount: 1,
    predictedVehicleName: 'Van',
    predictedVehicleReference: null,
    predictedVehicleCapacity: 15,
    contractedKm: 100,
    plannedKm: 90,
    maxWalkingDistanceMeters: 500,
    requiresDocumentation: false,
    requiredDocumentTypeCodes: [],
    unitName: 'Unidade A',
    origin: address,
    destination: { ...address, label: 'Unidade A', number: '200' },
    validFrom: new Date('2026-08-01T00:00:00Z'),
    validUntil: null,
    notes: null,
    costCenters: [{ id: 'cc-id', code: 'CC-01', name: 'Operacao' }],
    shifts: [
      {
        id: 'shift-id',
        name: 'Turno A',
        requiredArrivalTime: '07:00',
        vehicleCount: null,
        vehicleCapacity: null,
        activeWeekdays: [],
      },
    ],
    version: 1,
    createdByUserId: 'actor-id',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  } satisfies ContractProps,
  snapshot: {
    route: {
      id: 'route-id',
      code: 'CTR-01-A',
      name: 'Rota A',
      contractId: 'contract-id',
      shift: 'Turno A',
      requiredArrivalTime: '07:00',
      type: 'municipal',
      predictedVehicleName: 'Van',
      predictedVehicleReference: null,
      predictedVehicleCapacity: 15,
      plannedOutboundKm: 10,
      plannedReturnKm: 11,
      plannedTotalKm: 21,
      estimatedDurationMinutes: 35,
      version: 4,
      origin: address,
      destination: { ...address, label: 'Unidade A', number: '200' },
      notes: null,
    },
    points: [
      {
        id: 'point-id',
        sequence: 1,
        address: { ...address, label: 'Ponto Central', number: '100' },
        scheduledTime: '06:20',
        origin: 'agent',
        alerts: [],
      },
    ],
    assignments: [
      {
        passengerId: 'passenger-id',
        passengerName: 'Ana Souza',
        pointId: 'point-id',
        status: 'assigned',
        warnings: [],
      },
    ],
    navigationLinks: [
      { label: 'Link Rota 01', url: 'https://www.google.com/maps/dir/?api=1' },
    ],
  },
};

describe('RouteExportService', () => {
  it('creates My Maps CSV/XLSX without cost center', async () => {
    const service = new RouteExportService();
    const csv = service.myMapsCsv(context).toString('utf8');
    expect(csv).toContain('Contrato vinculado');
    expect(csv).toContain('Ana Souza');
    expect(csv).not.toContain('Centro de custo');
    expect(csv).not.toContain('CC-01');

    const xlsx = await service.myMapsXlsx(context);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      xlsx.buffer.slice(
        xlsx.byteOffset,
        xlsx.byteOffset + xlsx.byteLength,
      ) as ArrayBuffer,
    );
    const headers = workbook.getWorksheet('Google My Maps')?.getRow(1).values;
    expect(headers).toContain('Tipo do ponto');
    expect(headers).not.toContain('Centro de custo');
  });

  it('keeps cost center in operational Excel and emits a PDF', async () => {
    const service = new RouteExportService();
    const xlsx = await service.operationalXlsx(context);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      xlsx.buffer.slice(
        xlsx.byteOffset,
        xlsx.byteOffset + xlsx.byteLength,
      ) as ArrayBuffer,
    );
    const summary = workbook.getWorksheet('Resumo aprovado');
    expect(summary?.getCell('A4').text).toBe('Centro(s) de custo');
    expect(summary?.getCell('B4').text).toContain('CC-01');

    const pdf = service.operationalPdf(context);
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdf.toString('ascii')).toContain('Rota operacional aprovada');
  });
});
