"""Deterministically decimate, ground, consolidate, and render one sourced glTF asset."""
import bpy
import json
import math
import sys
from pathlib import Path


def triangles(obj):
    return sum(len(poly.vertices) - 2 for poly in obj.data.polygons if len(poly.vertices) >= 3)


def mesh_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']


def world_bounds(objects):
    points = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    return {
        'min': [min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)],
        'max': [max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)],
    }


def ensure_single_material(objects, asset_id):
    counts = {}
    for obj in objects:
        for polygon in obj.data.polygons:
            if polygon.material_index < len(obj.data.materials):
                material = obj.data.materials[polygon.material_index]
                if material:
                    counts[material.name] = counts.get(material.name, 0) + max(1, len(polygon.vertices) - 2)
    source = bpy.data.materials.get(max(counts, key=counts.get)) if counts else None
    consolidated = source.copy() if source else bpy.data.materials.new(name=f'{asset_id}_material')
    consolidated.name = f'{asset_id}_consolidated_pbr'
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(consolidated)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
    return consolidated


def source_scale_correction(objects, expected_dimensions):
    bounds = world_bounds(objects)
    measured = sorted(bounds['max'][i] - bounds['min'][i] for i in range(3))
    expected = sorted(expected_dimensions)
    ratios = sorted(measured[i] / expected[i] for i in range(3) if expected[i] > 0)
    correction = ratios[len(ratios) // 2]
    # Poly Haven metadata is authoritative for scale. Only correct a uniform 10x unit drift.
    if all(8.0 < ratio < 12.0 for ratio in ratios):
        for obj in objects:
            obj.location *= 0.1
            obj.scale *= 0.1
        bpy.context.view_layer.update()
        return 0.1
    if all(0.08 < ratio < 0.12 for ratio in ratios):
        for obj in objects:
            obj.location *= 10.0
            obj.scale *= 10.0
        bpy.context.view_layer.update()
        return 10.0
    return 1.0


def set_camera_for_objects(objects):
    bounds = world_bounds(objects)
    center = [(bounds['min'][i] + bounds['max'][i]) / 2 for i in range(3)]
    span = max(bounds['max'][i] - bounds['min'][i] for i in range(3))
    camera_data = bpy.data.cameras.new('QA Camera')
    camera = bpy.data.objects.new('QA Camera', camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = max(0.8, span * 1.65)
    camera.location = (center[0] + span * 1.7, center[1] - span * 1.7, center[2] + span * 1.2)
    target = bpy.data.objects.new('QA Target', None)
    target.location = center
    bpy.context.collection.objects.link(target)
    constraint = camera.constraints.new(type='TRACK_TO')
    constraint.target = target
    constraint.track_axis = 'TRACK_NEGATIVE_Z'
    constraint.up_axis = 'UP_Y'


def render_card(path, objects):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = 640
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.world.color = (0.055, 0.067, 0.082)
    for location, energy, size in [((4, -4, 7), 1100, 5), ((-4, -2, 4), 700, 4), ((0, 5, 3), 500, 3)]:
        data = bpy.data.lights.new('QA Area', type='AREA')
        data.energy = energy
        data.shape = 'DISK'
        data.size = size
        light = bpy.data.objects.new('QA Area', data)
        light.location = location
        bpy.context.collection.objects.link(light)
    set_camera_for_objects(objects)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    config_path = Path(sys.argv[sys.argv.index('--') + 1])
    config = json.loads(config_path.read_text())
    # --factory-startup includes a cube/light/camera; none may become source geometry.
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=config['sourceGltf'])
    objects = mesh_objects()
    if not objects:
        raise RuntimeError('glTF imported no meshes')
    scale_correction = source_scale_correction(objects, config['expectedDimensionsMeters'])
    before = sum(triangles(obj) for obj in objects)
    target = config['candidate']['targetTriangles']
    ratio = min(1.0, target / before)
    for obj in objects:
        if triangles(obj) < 12:
            continue
        modifier = obj.modifiers.new('market_lod0_decimate', 'DECIMATE')
        modifier.decimate_type = 'COLLAPSE'
        modifier.ratio = ratio
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    # Blender imported glTF in meters. Ground in Blender Z, which export maps to glTF +Y.
    minimum_z = min((obj.matrix_world @ vertex.co).z for obj in objects for vertex in obj.data.vertices)
    for obj in objects:
        obj.location.z -= minimum_z
    bpy.context.view_layer.update()
    consolidated = ensure_single_material(objects, config['candidate']['id'])
    after = sum(triangles(obj) for obj in objects)
    render_card(config['cardPng'], objects)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=config['outputGlb'], export_format='GLB', use_selection=True, export_lights=False, export_cameras=False, export_materials='EXPORT', export_image_format='AUTO')
    bounds = world_bounds(objects)
    Path(config['receiptPath']).write_text(json.dumps({
        'trianglesBeforeDecimation': before,
        'triangles': after,
        'materials': 1,
        'decimationRatio': ratio,
        'sourceScaleCorrection': scale_correction,
        'sourceMaterial': consolidated.name,
        'grounding': {'blenderUpAxis': '+Z', 'minimumZAfterGrounding': min((obj.matrix_world @ vertex.co).z for obj in objects for vertex in obj.data.vertices)},
        'boundsBlenderMeters': bounds,
        'closeCard': Path(config['cardPng']).name,
        'lighting': 'No lights, cameras, or emissive bake were exported; preview lights exist only in the isolated QA render.',
    }, indent=2) + '\n')


main()
